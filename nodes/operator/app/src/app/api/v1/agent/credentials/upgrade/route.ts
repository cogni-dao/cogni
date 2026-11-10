// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/credentials/upgrade`
 * Purpose: A valid v1 agent key mints a PENDING v2 key for the SAME users.id (story.5156, child of task.5474). The caller stores the
 *   v2 key, then calls `confirm` with it.
 * Scope: v1-bearer gate and error mapping; does not mint or store keys itself. The key, the principal row and every refusal rule live in `@cogni-dao/agent-grants/credentials`.
 *   1-1 port of node-template upgrade/route.ts; one sanctioned divergence: operator SessionUser has no `via`, so the v1-bearer gate reads
 *   the raw bearer prefix (the resolver is bearer-exclusive, so a resolved user with a v1 bearer header WAS authenticated by it).
 * Invariants:
 *   - V1_ONLY: the caller must authenticate with a v1 key (a session or a v2 key is 403 `v1_bearer_required`). An expired v1 key never reaches
 *     here (the resolver answers 401).
 *   - Refuses a wallet user and an internal principal (403 `not_agent_key`), a user that already holds a live v2 key (409 `already_upgraded`),
 *     and a principal with node roles and no GitHub binding (409 `binding_required`, BINDING_BEFORE_UPGRADE).
 *   - The v1 key keeps working while the v2 key is only pending. Once the v2 key is confirmed the v1 key is superseded (401 `v1_superseded`, resolver).
 *     Never logs or stores a key. A store failure at any step is 503 `authz_unavailable`.
 * Side-effects: IO (service-role db), log `agent.credential.upgraded`
 * Links: https://cognidao.org/work/items/story.5156, https://cognidao.org/work/items/task.5474
 * @public
 */

import { upgradeAgentCredentialOperation } from "@cogni/node-contracts";
import { upgradeFromV1 } from "@cogni-dao/agent-grants/credentials";

import {
  answerStoreOutage,
  credentialJson,
} from "@/app/_lib/auth/agent-credential-route";
import { currentBearerToken } from "@/app/_lib/auth/request-identity";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getAgentCredentialStore } from "@/bootstrap/agent-credentials";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REFUSALS = {
  unknown_user: [403, "not_agent_key"],
  wallet_user: [403, "not_agent_key"],
  internal_principal: [403, "not_agent_key"],
  not_rotatable: [409, "not_rotatable"],
  already_upgraded: [409, "already_upgraded"],
  binding_required: [409, "binding_required"],
} as const;

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.credentials.upgrade",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser) => {
    const refuse = (status: number, error: string) => {
      ctx.log.warn(
        {
          event: EVENT_NAMES.AGENT_CREDENTIAL_REFUSED,
          routeId: "agent.credentials.upgrade",
          userId: sessionUser.id,
          reason: error,
        },
        EVENT_NAMES.AGENT_CREDENTIAL_REFUSED
      );
      return credentialJson({ error }, status);
    };
    const bearer = await currentBearerToken();
    if (!bearer?.startsWith("cogni_ag_sk_v1_"))
      return refuse(403, "v1_bearer_required");

    return answerStoreOutage(async () => {
      const minted = await upgradeFromV1(getAgentCredentialStore(), {
        userId: sessionUser.id,
      });
      if (!minted.ok) {
        const [status, error] = REFUSALS[minted.reason];
        return refuse(status, error);
      }
      ctx.log.info(
        {
          event: EVENT_NAMES.AGENT_CREDENTIAL_UPGRADED,
          userId: minted.userId,
          credentialId: minted.credentialId,
        },
        EVENT_NAMES.AGENT_CREDENTIAL_UPGRADED
      );
      return credentialJson(
        upgradeAgentCredentialOperation.output.parse({
          userId: minted.userId,
          credentialId: minted.credentialId,
          apiKey: minted.apiKey,
          status: "pending",
          pendingExpiresAt: minted.pendingExpiresAt,
        })
      );
    });
  }
);
