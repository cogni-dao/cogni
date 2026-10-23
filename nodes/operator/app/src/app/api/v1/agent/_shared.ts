// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { type NextRequest, NextResponse } from "next/server";
import { extractBearerToken } from "@/app/_lib/auth/request-identity";
import { agentIdentityApiLimiter, extractClientIp } from "@/bootstrap/http";
import { AgentIdentityError } from "@/ports";
import { EVENT_NAMES, type RequestContext } from "@/shared/observability";
import { createRouteTerminalLogger } from "@/shared/observability/server";

export type AgentIdentityOperation =
  | "claim_accept"
  | "claim_create"
  | "confirm"
  | "me"
  | "recover"
  | "recovery_grant"
  | "register"
  | "rotate"
  | "spawn_grant"
  | "status"
  | "suspend"
  | "upgrade";

const AGENT_IDENTITY_REASON_CODES = new Set([
  "authn_unavailable",
  "authz_unavailable",
  "billing_account_missing",
  "claim_conflict",
  "claim_denied",
  "claim_expired",
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
  const response = NextResponse.json(body, init);
  createRouteTerminalLogger(
    ctx,
    EVENT_NAMES.AGENT_IDENTITY_OPERATION_COMPLETE,
    startedAt,
    { operation }
  ).complete({
    status: statusCode,
    outcome: statusCode < 400 ? "success" : "error",
    ...(statusCode >= 400
      ? {
          errorCode: `http_${statusCode}`,
          reasonCode: reasonCodeFor(body, statusCode),
        }
      : {}),
  });
  return response;
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

export async function requestJson(
  request: Request
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false };
  }
}

/** Cookie-authenticated agent mutations require an explicit same-origin proof. */
export function isSameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = (
    request.headers.get("x-forwarded-host") ?? request.headers.get("host")
  )
    ?.split(",", 1)[0]
    ?.trim();
  if (!origin || !host) return false;
  try {
    const requestUrl = new URL(request.url);
    const forwardedProto = request.headers
      .get("x-forwarded-proto")
      ?.split(",", 1)[0]
      ?.trim();
    const scheme = forwardedProto || requestUrl.protocol.slice(0, -1);
    return new URL(origin).origin === new URL(`${scheme}://${host}`).origin;
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
  if (!(error instanceof AgentIdentityError)) {
    logAgentIdentityUnexpectedError(ctx, startedAt, operation);
    return null;
  }
  const status =
    error.code === "spawn_limit" || error.code === "grant_limit"
      ? 429
      : error.code === "rotation_pending" ||
          error.code === "grant_already_redeemed"
        ? 409
        : error.code === "billing_account_missing" ||
            error.code === "claim_conflict"
          ? 409
          : error.code === "recovery_denied" || error.code === "claim_denied"
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

/** Emit the feature terminal marker before the route wrapper owns the 500. */
export function logAgentIdentityUnexpectedError(
  ctx: RequestContext,
  startedAt: number,
  operation: AgentIdentityOperation
): void {
  createRouteTerminalLogger(
    ctx,
    EVENT_NAMES.AGENT_IDENTITY_OPERATION_COMPLETE,
    startedAt,
    { operation }
  ).internalError();
}
