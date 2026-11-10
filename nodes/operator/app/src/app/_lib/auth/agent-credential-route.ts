// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_lib/auth/agent-credential-route`
 * Purpose: Shared shell of the v2 key routes that authenticate WITH a v2 key (rotate, confirm, revoke): read the bearer, verify it
 *   against the credential store for the states the route accepts, answer 401 or 503, else hand the caller to the handler.
 * Scope: Auth and response plumbing only. The state machine lives in `@cogni-dao/agent-grants/credentials`, not here. 1-1 port of
 *   node-template app/_lib/auth/agent-credential-route.ts (story.5156).
 * Invariants:
 *   - FAIL_CLOSED_NON_DISCLOSING: a missing, forged, revoked, expired or wrong-state key is the same 401 `invalid_token`.
 *   - STORE_OUTAGE_IS_NOT_401: a store failure is 503 `authz_unavailable`, at verify AND after it (mid-handler), via `answerStoreOutage`.
 *   - Responses carry `cache-control: no-store`; a key is never logged.
 * Side-effects: IO (credential store read)
 * Links: https://cognidao.org/work/items/story.5156
 * @internal
 */

import {
  type CredentialState,
  CredentialStoreUnavailableError,
} from "@cogni-dao/agent-grants/credentials";
import { type NextRequest, NextResponse } from "next/server";

import {
  currentBearerToken,
  verifyAgentKeyV2,
} from "@/app/_lib/auth/request-identity";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import type { RequestContext } from "@/shared/observability";

const NO_STORE = { "cache-control": "no-store" } as const;
export const credentialJson = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: NO_STORE });

/** Run a handler step; a `CredentialStoreUnavailableError` anywhere in it is 503 `authz_unavailable`. Other errors propagate. */
export async function answerStoreOutage(
  run: () => Promise<NextResponse>
): Promise<NextResponse> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CredentialStoreUnavailableError)
      return credentialJson({ error: "authz_unavailable" }, 503);
    throw error;
  }
}

export interface CredentialCaller {
  readonly userId: string;
  readonly credentialId: string;
}

export function credentialBearerRoute(options: {
  routeId: string;
  /** The v2 states this route accepts. */
  allow: readonly CredentialState[];
  handle: (input: {
    ctx: RequestContext;
    request: NextRequest;
    caller: CredentialCaller;
  }) => Promise<NextResponse>;
}) {
  return wrapRouteHandlerWithLogging(
    { routeId: options.routeId, auth: { mode: "none" } },
    (ctx, request) =>
      answerStoreOutage(async () => {
        const token = await currentBearerToken();
        const verified = token
          ? await verifyAgentKeyV2(token, options.allow)
          : null;
        if (verified?.ok) {
          return options.handle({
            ctx,
            request,
            caller: {
              userId: verified.userId,
              credentialId: verified.credentialId,
            },
          });
        }
        if (verified?.reason === "unavailable")
          return credentialJson({ error: "authz_unavailable" }, 503);
        return NextResponse.json(
          { error: "invalid_token" },
          {
            status: 401,
            headers: {
              ...NO_STORE,
              "www-authenticate": 'Bearer error="invalid_token"',
            },
          }
        );
      })
  );
}
