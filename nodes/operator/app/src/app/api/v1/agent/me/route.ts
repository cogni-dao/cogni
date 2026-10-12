// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/me`
 * Purpose: Agent self-identity + key-liveness endpoint.
 * Scope: Returns the CALLING principal's own userId, displayName, and — for
 *   agent API keys — the key's expiry. The agent-first counterpart to
 *   `/api/v1/users/me`, which is wired to the session-cookie-only resolver
 *   (`getServerSessionUser`) and therefore 401s for a valid agent key — the
 *   ambiguity that makes agents misdiagnose a live key as "expired".
 * Invariants:
 *   - SELF_ONLY: returns only the authenticated caller's principal.
 *   - UNAMBIGUOUS_LIVENESS: a 200 proves the credential is live; a 401 proves it
 *     is genuinely expired/invalid, because `getSessionUser`
 *     (resolveRequestIdentity) rejects expired tokens before this handler runs.
 *   - NO_AUTHZ_IO: identity only; does not enumerate RBAC grants.
 * Side-effects: none (reads the already-verified request identity).
 * Links: agent.me.v1.contract, /api/v1/cognition, request-identity.ts
 * @public
 */

import { agentMeOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import {
  getSessionUser,
  peekAgentKeyExpiry,
} from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "agent.me.read", auth: { mode: "required", getSessionUser } },
  async (_ctx, _request, sessionUser) => {
    const exp = await peekAgentKeyExpiry();
    const nowSeconds = Math.floor(Date.now() / 1000);

    const result = agentMeOperation.output.parse({
      userId: sessionUser.id,
      displayName: sessionUser.displayName,
      principal: exp !== null ? "agent" : "session",
      expiresAt: exp !== null ? new Date(exp * 1000).toISOString() : null,
      expiresInSeconds: exp !== null ? exp - nowSeconds : null,
    });

    return NextResponse.json(result);
  }
);

export const dynamic = "force-dynamic";
