// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/me`
 * Purpose: Agent self-identity + key-liveness endpoint.
 * Scope: Returns the CALLING principal's own identity + role grants; does not
 *   expose any other principal. Carries userId, displayName, agent-key expiry,
 *   and per-node roles. The agent-first counterpart to `/api/v1/users/me`,
 *   which is wired to the session-cookie-only resolver (`getServerSessionUser`)
 *   and therefore 401s for a valid agent key — the ambiguity that makes agents
 *   misdiagnose a live key as "expired".
 * Invariants:
 *   - SELF_ONLY: returns only the authenticated caller's principal + grants.
 *   - UNAMBIGUOUS_LIVENESS: a 200 proves the credential is live; a 401 proves it
 *     is genuinely expired/invalid, because `getSessionUser`
 *     (resolveRequestIdentity) rejects expired tokens before this handler runs.
 *   - GRANTS_NEVER_BLOCK_LIVENESS: grant enumeration is best-effort; an absent or
 *     failing authz plane yields `grantsAvailable:false` + `nodes:[]`, never a 5xx.
 * Side-effects: none (reads the already-verified request identity).
 * Links: agent.me.v1.contract, /api/v1/cognition, request-identity.ts
 * @public
 */

import { authzUserResource } from "@cogni/authorization-core";
import { agentMeOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser, peekAgentKeyExpiry } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

const NODE_PREFIX = "node:";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "agent.me.read", auth: { mode: "required", getSessionUser } },
  async (_ctx, _request, sessionUser) => {
    const exp = await peekAgentKeyExpiry();
    const nowSeconds = Math.floor(Date.now() / 1000);

    // Grants are best-effort: the authz plane must NEVER break liveness. If the
    // adapter is absent (no OpenFGA store) or the read fails, we report
    // grantsAvailable=false and an empty node list rather than erroring.
    const authorization = getContainer().authorization;
    let grantsAvailable = false;
    const rolesByNode = new Map<string, Set<string>>();
    if (authorization) {
      const listed = await authorization.listRelations(
        authzUserResource(sessionUser.id)
      );
      if (listed.decision === "success") {
        grantsAvailable = true;
        for (const tuple of listed.tuples) {
          const nodeId = tuple.object.startsWith(NODE_PREFIX)
            ? tuple.object.slice(NODE_PREFIX.length)
            : tuple.object;
          const roles = rolesByNode.get(nodeId) ?? new Set<string>();
          roles.add(tuple.relation);
          rolesByNode.set(nodeId, roles);
        }
      }
    }

    const nodes = [...rolesByNode.entries()]
      .map(([nodeId, roles]) => ({ nodeId, roles: [...roles].sort() }))
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));

    const result = agentMeOperation.output.parse({
      userId: sessionUser.id,
      displayName: sessionUser.displayName,
      principal: exp !== null ? "agent" : "session",
      expiresAt: exp !== null ? new Date(exp * 1000).toISOString() : null,
      expiresInSeconds: exp !== null ? exp - nowSeconds : null,
      grantsAvailable,
      nodes,
    });

    return NextResponse.json(result);
  }
);

export const dynamic = "force-dynamic";
