// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/credentials/upgrade`
 * Purpose: A valid v1 agent key mints a PENDING revocable key for the SAME users.id (story.5156, child of task.5474). The caller stores the
 *   revocable key, then calls `confirm` with it.
 * Scope: v1-bearer gate and delegation; does not implement the key, the principal row, the refusal rules or the result-to-HTTP mapping
 *   (`credentialHttp`) — those live in `@cogni-dao/agent-grants/credentials`. 1-1 port of node-template upgrade/route.ts (story.5156); one
 *   recorded divergence: operator SessionUser carries no `via`, so the v1 gate reads the raw bearer prefix (the resolver is bearer-exclusive,
 *   so a resolved user with a v1 bearer header WAS authenticated by it).
 * Invariants:
 *   - V1_ONLY: the caller must authenticate with a signed key (a session or a revocable key is 403 `signed_key_required`). An expired signed key
 *     never reaches here (the resolver answers 401).
 *   - Refuses a wallet user and an internal principal (403 `not_agent_key`), a user that already holds a live revocable key (409 `already_upgraded`),
 *     and a principal with node roles and no GitHub binding (409 `binding_required`, BINDING_BEFORE_UPGRADE — on the operator, roles span
 *     OpenFGA deploy tuples AND agent_roles via the injected `hasRoles`).
 *   - The signed key keeps working while the revocable key is only pending. Once the revocable key is confirmed the signed key is superseded
 *     (401 `v1_superseded`, resolver). Never logs or stores a key. A store failure at any step is 503 `authz_unavailable`.
 * Side-effects: IO (service-role db, OpenFGA read), log `agent.credential.upgraded`
 * Links: https://cognidao.org/work/items/story.5156, https://cognidao.org/work/items/task.5474
 * @public
 */

import {
  type CredentialHttpInput,
  credentialHttp,
  upgradeSignedKey,
} from "@cogni-dao/agent-grants/credentials";

import {
  answerStoreOutage,
  credentialResponse,
} from "@/app/_lib/auth/agent-credential-route";
import { currentBearerToken } from "@/app/_lib/auth/request-identity";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getAgentCredentialStore } from "@/bootstrap/agent-credentials";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.credentials.upgrade",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser) => {
    /** One log line per refusal; the status, body and headers come from the package's mapping. */
    const answer = (input: CredentialHttpInput) => {
      const res = credentialHttp(input);
      if (res.refusal) {
        ctx.log.warn(
          {
            event: EVENT_NAMES.AGENT_CREDENTIAL_REFUSED,
            routeId: "agent.credentials.upgrade",
            userId: sessionUser.id,
            reason: res.refusal,
          },
          EVENT_NAMES.AGENT_CREDENTIAL_REFUSED
        );
      }
      return credentialResponse(res);
    };
    const bearer = await currentBearerToken();
    if (!bearer?.startsWith("cogni_ag_sk_v1_"))
      return answer({ op: "signed_key_required" });

    return answerStoreOutage(ctx, "agent.credentials.upgrade", async () => {
      const minted = await upgradeSignedKey(getAgentCredentialStore(), {
        userId: sessionUser.id,
      });
      if (minted.ok) {
        ctx.log.info(
          {
            event: EVENT_NAMES.AGENT_CREDENTIAL_UPGRADED,
            userId: minted.userId,
            credentialId: minted.credentialId,
          },
          EVENT_NAMES.AGENT_CREDENTIAL_UPGRADED
        );
      }
      return answer({ op: "upgrade", result: minted });
    });
  }
);
