// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { NextResponse } from "next/server";
import { extractBearerToken } from "@/app/_lib/auth/request-identity";
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
    ...(statusCode >= 400 ? { errorCode: `http_${statusCode}` } : {}),
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
    error.code === "spawn_limit"
      ? 429
      : error.code === "rotation_pending"
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
