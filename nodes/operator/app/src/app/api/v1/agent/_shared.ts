// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { type NextRequest, NextResponse } from "next/server";
import { extractBearerToken } from "@/app/_lib/auth/request-identity";
import { agentIdentityApiLimiter, extractClientIp } from "@/bootstrap/http";
import { AgentIdentityError } from "@/ports";
import {
  EVENT_NAMES,
  logEvent,
  type RequestContext,
} from "@/shared/observability";

export type AgentIdentityOperation =
  | "confirm"
  | "me"
  | "recover"
  | "recovery_grant"
  | "register"
  | "rotate"
  | "spawn_grant"
  | "status"
  | "upgrade";

const AGENT_IDENTITY_REASON_CODES = new Set([
  "authn_unavailable",
  "authz_unavailable",
  "billing_account_missing",
  "csrf_denied",
  "grant_already_redeemed",
  "grant_expired",
  "grant_limit",
  "invalid_credential",
  "invalid_grant",
  "invalid_request",
  "invalid_token",
  "recovery_denied",
  "rate_limited",
  "rotation_pending",
  "spawn_limit",
]);

function reasonCodeFor(body: unknown, statusCode: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (error === "Invalid request") return "invalid_request";
    if (typeof error === "string" && AGENT_IDENTITY_REASON_CODES.has(error)) {
      return error;
    }
  }
  return `http_${statusCode}`;
}

/** One privacy-safe, feature-specific terminal marker for candidate validation. */
export function agentIdentityResponse(
  ctx: RequestContext,
  startedAt: number,
  operation: AgentIdentityOperation,
  body: unknown,
  init?: ResponseInit
): NextResponse {
  const statusCode = init?.status ?? 200;
  const payload = {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    operation,
    outcome: statusCode < 400 ? "success" : "error",
    statusCode,
    durationMs: Math.round(performance.now() - startedAt),
    ...(statusCode >= 400
      ? {
          errorCode: `http_${statusCode}`,
          reasonCode: reasonCodeFor(body, statusCode),
        }
      : {}),
  } as const;
  if (statusCode < 400) {
    logEvent(ctx.log, EVENT_NAMES.AGENT_IDENTITY_OPERATION_COMPLETE, payload);
  } else {
    const level = statusCode >= 500 ? "error" : "warn";
    ctx.log[level](
      { event: EVENT_NAMES.AGENT_IDENTITY_OPERATION_COMPLETE, ...payload },
      EVENT_NAMES.AGENT_IDENTITY_OPERATION_COMPLETE
    );
  }
  return NextResponse.json(body, init);
}

/** Bound every lifecycle operation before it reaches identity persistence. */
export function agentIdentityRateLimitResponse(
  ctx: RequestContext,
  startedAt: number,
  operation: AgentIdentityOperation,
  request: NextRequest
): NextResponse | null {
  const key = `${operation}:${extractClientIp(request)}`;
  if (agentIdentityApiLimiter.consume(key)) return null;
  return agentIdentityResponse(
    ctx,
    startedAt,
    operation,
    { error: "rate_limited" },
    { status: 429, headers: { "Retry-After": "2" } }
  );
}

export function requestBearer(request: Request): string | null {
  return extractBearerToken(request.headers.get("authorization"));
}

/** Cookie-authenticated agent mutations require an explicit same-origin proof. */
export function isSameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function agentIdentityErrorResponse(
  ctx: RequestContext,
  startedAt: number,
  operation: AgentIdentityOperation,
  error: unknown
): NextResponse | null {
  if (!(error instanceof AgentIdentityError)) return null;
  const status =
    error.code === "spawn_limit" || error.code === "grant_limit"
      ? 429
      : error.code === "rotation_pending" ||
          error.code === "grant_already_redeemed"
        ? 409
        : error.code === "billing_account_missing"
          ? 409
          : error.code === "recovery_denied"
            ? 403
            : 401;
  return agentIdentityResponse(
    ctx,
    startedAt,
    operation,
    { error: error.code, error_description: error.message },
    {
      status,
      ...(status === 429 ? { headers: { "Retry-After": "600" } } : {}),
    }
  );
}
