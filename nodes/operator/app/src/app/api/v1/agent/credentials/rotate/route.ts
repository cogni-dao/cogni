// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/credentials/rotate`
 * Purpose: A revocable key (active, or renew_only inside its renew window) mints its PENDING successor for the same users.id. The old key keeps
 *   working until the successor is confirmed (`confirm`).
 * Scope: Auth shell and delegation; does not implement supersede, locking or the result-to-HTTP mapping (`credentialHttp`) — those live in
 *   `@cogni-dao/agent-grants/credentials`. 1-1 port of node-template rotate/route.ts (story.5156).
 * Invariants:
 *   - REPLAY_CONVERGES: rotate takes no idempotency key. A repeat call revokes the earlier unconfirmed successor (`superseded`) and
 *     returns a NEW key, so a lost response is fixed by calling again. One live pending successor per predecessor.
 *   - Never logs or stores a key.
 * Side-effects: IO (service-role db), log `agent.credential.rotated`
 * Links: https://cognidao.org/work/items/story.5156
 * @public
 */

import {
  credentialHttp,
  rotateCredential,
} from "@cogni-dao/agent-grants/credentials";

import {
  credentialBearerRoute,
  credentialResponse,
} from "@/app/_lib/auth/agent-credential-route";
import { getAgentCredentialStore } from "@/bootstrap/agent-credentials";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = credentialBearerRoute({
  routeId: "agent.credentials.rotate",
  allow: ["active", "renew_only"],
  async handle({ ctx, caller }) {
    const minted = await rotateCredential(getAgentCredentialStore(), {
      credentialId: caller.credentialId,
    });
    if (minted.ok) {
      ctx.log.info(
        {
          event: EVENT_NAMES.AGENT_CREDENTIAL_ROTATED,
          userId: minted.userId,
          credentialId: minted.credentialId,
          predecessorId: caller.credentialId,
        },
        EVENT_NAMES.AGENT_CREDENTIAL_ROTATED
      );
    }
    return credentialResponse(credentialHttp({ op: "rotate", result: minted }));
  },
});
