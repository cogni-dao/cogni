// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/auth/route-identity`
 * Purpose: Apply the existing package HTTP mapping at direct route resolver boundaries.
 * Scope: Response plumbing only; the supplied existing resolver remains the authentication authority.
 * Invariants: Preserve 401/429/503 and headers; unknown errors propagate; callers retain terminal logging.
 * Side-effects: IO (calls supplied resolver).
 * Links: request-identity.ts, bootstrap/http/wrapRouteHandlerWithLogging.ts, story.5156
 */
import { credentialErrorHttp } from "@cogni-dao/agent-grants/credentials";
import { NextResponse } from "next/server";

export async function resolveRouteIdentity<T>(
  resolve: () => Promise<T>
): Promise<
  | { ok: true; user: T }
  | { ok: false; response: NextResponse; status: number; errorCode: string }
> {
  try {
    return { ok: true, user: await resolve() };
  } catch (error) {
    const refusal = credentialErrorHttp(error);
    if (!refusal || typeof refusal.body.error !== "string") throw error;
    return {
      ok: false,
      status: refusal.status,
      errorCode: refusal.body.error,
      response: NextResponse.json(refusal.body, {
        status: refusal.status,
        headers: { ...refusal.headers },
      }),
    };
  }
}
