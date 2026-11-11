// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_lib/auth/agent-credential-route`
 * Purpose: Shared shell of the revocable key routes that authenticate WITH a revocable key (rotate, confirm, revoke): read the bearer, verify it
 *   against the credential store for the states the route accepts, answer 401, 429 or 503, else hand the caller to the handler.
 * Scope: Auth and response plumbing only. The state machine lives in `@cogni-dao/agent-grants/credentials`, not here. 1-1 port of
 *   node-template app/_lib/auth/agent-credential-route.ts (story.5156).
 * Invariants:
 *   - FAIL_CLOSED_NON_DISCLOSING: a missing, forged, revoked, expired or wrong-state key is the same 401 `invalid_token`.
 *   - STORE_OUTAGE_IS_NOT_401: a store failure is 503 `authz_unavailable`, at verify AND after it (mid-handler), via `answerStoreOutage`.
 *     Status, body and headers come from `@cogni-dao/agent-grants/credentials` (`credentialDenialHttp`), never typed out here.
 *   - OVER_LIMIT_IS_429: a client over the per-IP lookup limit gets 429 `rate_limited` and no store read.
 *   - DENIALS_ARE_LOGGED: an invalid key (401) and an over-limit client (429) each log one event with routeId only: never a key, hash or prefix.
 *   - Responses carry `cache-control: no-store` (the package's mapping); a key is never logged.
 * Side-effects: IO (credential store read)
 * Links: https://cognidao.org/work/items/story.5156
 * @internal
 */

import {
  type CredentialHttpResponse,
  type CredentialState,
  credentialDenialHttp,
  credentialErrorHttp,
  storeFailureFields,
} from "@cogni-dao/agent-grants/credentials";
import { type NextRequest, NextResponse } from "next/server";

import {
  currentBearerToken,
  verifyRevocableKey,
} from "@/app/_lib/auth/request-identity";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, type RequestContext } from "@/shared/observability";

/** The one place a package `{ status, body, headers }` becomes a Next response. The mapping itself is the package's. */
export const credentialResponse = (
  http: CredentialHttpResponse
): NextResponse =>
  NextResponse.json(http.body, {
    status: http.status,
    headers: { ...http.headers },
  });

/** Run a handler step; a `CredentialStoreUnavailableError` anywhere in it is 503 `authz_unavailable`. Other errors propagate. */
export async function answerStoreOutage(
  ctx: RequestContext,
  routeId: string,
  run: () => Promise<NextResponse>
): Promise<NextResponse> {
  try {
    return await run();
  } catch (error) {
    const http = credentialErrorHttp(error);
    if (http?.status === 503) {
      logStoreUnavailable(ctx, routeId, error);
      return credentialResponse(http);
    }
    throw error;
  }
}

/** One `store_unavailable` line: routeId, plus the cause's class and SQLSTATE (never its message, which can hold a key hash). */
function logStoreUnavailable(
  ctx: RequestContext,
  routeId: string,
  source: unknown
): void {
  ctx.log.warn(
    {
      event: EVENT_NAMES.AGENT_CREDENTIAL_STORE_UNAVAILABLE,
      routeId,
      ...storeFailureFields(source),
    },
    EVENT_NAMES.AGENT_CREDENTIAL_STORE_UNAVAILABLE
  );
}

export interface CredentialCaller {
  readonly userId: string;
  readonly credentialId: string;
}

export function credentialBearerRoute(options: {
  routeId: string;
  /** The key states this route accepts. */
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
      answerStoreOutage(ctx, options.routeId, async () => {
        const token = await currentBearerToken();
        const verified = token
          ? await verifyRevocableKey(token, options.allow)
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
          logStoreUnavailable(ctx, options.routeId, verified);
        if (verified?.reason === "rate_limited") {
          ctx.log.warn(
            {
              event: EVENT_NAMES.AGENT_CREDENTIAL_RATE_LIMITED,
              routeId: options.routeId,
            },
            EVENT_NAMES.AGENT_CREDENTIAL_RATE_LIMITED
          );
        }
        // A missing bearer is not a credential denial; a refused key is. No userId: the key did not identify anyone.
        if (token && verified?.reason === "invalid") {
          ctx.log.warn(
            {
              event: EVENT_NAMES.AGENT_CREDENTIAL_INVALID_DENIED,
              routeId: options.routeId,
            },
            EVENT_NAMES.AGENT_CREDENTIAL_INVALID_DENIED
          );
        }
        return credentialResponse(
          credentialDenialHttp(
            verified && !verified.ok ? verified.reason : "invalid"
          )
        );
      })
  );
}
