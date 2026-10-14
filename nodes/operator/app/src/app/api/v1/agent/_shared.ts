// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { NextResponse } from "next/server";
import { extractBearerToken } from "@/app/_lib/auth/request-identity";
import { AgentIdentityError } from "@/ports";

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
  return NextResponse.json(
    { error: error.code, error_description: error.message },
    {
      status,
      ...(status === 429 ? { headers: { "Retry-After": "600" } } : {}),
    }
  );
}
