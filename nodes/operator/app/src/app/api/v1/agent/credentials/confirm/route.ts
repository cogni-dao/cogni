// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/credentials/confirm`
 * Purpose: Called WITH the pending successor key (that proves the caller stored it): one transaction activates it and revokes its predecessor.
 *   After this the old key is dead (zero overlap after confirm).
 * Scope: Auth shell and response mapping; does not implement the transaction. The transaction lives in `@cogni-dao/agent-grants/credentials`. 1-1 port of
 *   node-template confirm/route.ts (story.5156).
 * Invariants:
 *   - IDEMPOTENT: confirming an already active key is 200 with `replay: true`. A revoked key never reaches here (401); a race that revokes it
 *     first is 409 `superseded`. A predecessor revoked meanwhile is 409 `predecessor_revoked`; an unconfirmed key past its window is 409 `pending_expired`.
 *   - DB clock decides expiry. Never logs a key.
 * Side-effects: IO (service-role db), log `agent.credential.confirmed`
 * Links: https://cognidao.org/work/items/story.5156
 * @public
 */

import { confirmAgentCredentialOperation } from "@cogni/node-contracts";
import { confirmCredential } from "@cogni-dao/agent-grants/credentials";

import {
  credentialBearerRoute,
  credentialJson,
} from "@/app/_lib/auth/agent-credential-route";
import { getAgentCredentialStore } from "@/bootstrap/agent-credentials";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REFUSALS = {
  revoked: "superseded",
  expired: "pending_expired",
  predecessor_revoked: "predecessor_revoked",
  not_found: "superseded",
} as const;

export const POST = credentialBearerRoute({
  routeId: "agent.credentials.confirm",
  allow: ["pending", "active"],
  async handle({ ctx, caller }) {
    const result = await confirmCredential(getAgentCredentialStore(), {
      credentialId: caller.credentialId,
    });
    if (!result.ok)
      return credentialJson({ error: REFUSALS[result.reason] }, 409);
    if (result.status === "confirmed") {
      ctx.log.info(
        {
          event: EVENT_NAMES.AGENT_CREDENTIAL_CONFIRMED,
          userId: result.userId,
          credentialId: caller.credentialId,
        },
        EVENT_NAMES.AGENT_CREDENTIAL_CONFIRMED
      );
    }
    return credentialJson(
      confirmAgentCredentialOperation.output.parse({
        userId: result.userId,
        credentialId: caller.credentialId,
        status: "active",
        replay: result.status === "already_active",
        expiresAt: result.expiresAt,
        renewUntil: result.renewUntil,
      })
    );
  },
});
