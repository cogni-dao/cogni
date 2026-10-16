// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { authzUserResource } from "@cogni/authorization-core";
import { upgradeLegacyAgentCredentialOperation } from "@cogni/node-contracts";
import { verifyLegacyAgentApiKey } from "@/app/_lib/auth/request-identity";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";
import {
  agentIdentityErrorResponse,
  agentIdentityRateLimitResponse,
  agentIdentityResponse,
  requestBearer,
  requestJson,
} from "../_shared";

export const runtime = "nodejs";

// Freeze this migration allowlist independently from the access-request
// catalog. Adding a future human/node role must never silently make it
// transferable to a legacy agent.
const MIGRATABLE_NODE_ROLES = new Set([
  "developer",
  "secrets_manager",
  "production_promoter",
  "env_manager",
]);

function isMigratableNodeGrant(tuple: {
  object: string;
  relation: string;
}): boolean {
  return (
    tuple.object === `node:${getNodeId()}` &&
    MIGRATABLE_NODE_ROLES.has(tuple.relation)
  );
}

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.credentials.legacy_upgrade", auth: { mode: "none" } },
  async (ctx, request) => {
    const startedAt = performance.now();
    const rateLimited = agentIdentityRateLimitResponse(
      ctx,
      startedAt,
      "upgrade",
      request
    );
    if (rateLimited) return rateLimited;
    const token = requestBearer(request);
    const body = await requestJson(request);
    const legacy = token ? verifyLegacyAgentApiKey(token) : null;
    const parsed = upgradeLegacyAgentCredentialOperation.input.safeParse(
      body.ok ? body.value : undefined
    );
    if (!token || !legacy || !parsed.success) {
      return agentIdentityResponse(
        ctx,
        startedAt,
        "upgrade",
        { error: "invalid_token" },
        { status: 401 }
      );
    }
    try {
      const container = getContainer();
      if (!container.authorization) {
        return agentIdentityResponse(
          ctx,
          startedAt,
          "upgrade",
          { error: "authz_unavailable" },
          { status: 503 }
        );
      }
      const result = await container.agentIdentity.upgradeLegacy({
        legacyToken: token,
        legacyUserId: legacy.sub,
        displayName: legacy.displayName,
        idempotencyKey: parsed.data.idempotencyKey,
      });

      if (result.grantTransferRequired) {
        let transferComplete = false;
        try {
          // The pending credential records the one-time transition before any
          // OpenFGA write. Exact retries can resume a failed copy, while an
          // active/revoked predecessor can never trigger another copy.
          const sourceSubjects = new Set([
            authzUserResource(legacy.sub),
            `user:${getNodeId()}/${legacy.sub}`,
          ]);
          const grantsByKey = new Map<
            string,
            { user: string; relation: string; object: string }
          >();
          for (const source of sourceSubjects) {
            const listed = await container.authorization.listRelations(source);
            if (listed.decision !== "success") {
              return agentIdentityResponse(
                ctx,
                startedAt,
                "upgrade",
                { error: "authz_unavailable" },
                { status: 503 }
              );
            }
            for (const tuple of listed.tuples) {
              if (!isMigratableNodeGrant(tuple)) continue;
              const grant = {
                user: result.principalId,
                relation: tuple.relation,
                object: tuple.object,
              };
              grantsByKey.set(`${grant.relation}\0${grant.object}`, grant);
            }
          }
          // One OpenFGA transaction prevents a failed multi-role copy from
          // leaving stale destination authority for an exact retry to activate.
          // Duplicate source subject spellings collapse to the same grant.
          const written =
            await container.authorization.writeRelationsAtomically([
              ...grantsByKey.values(),
            ]);
          if (written.decision !== "success") {
            return agentIdentityResponse(
              ctx,
              startedAt,
              "upgrade",
              { error: "authz_unavailable" },
              { status: 503 }
            );
          }
          await container.agentIdentity.completeLegacyUpgrade({
            legacyUserId: legacy.sub,
            credentialId: result.credentialId,
            transferLeaseId: result.transferLeaseId,
          });
          transferComplete = true;
        } finally {
          if (!transferComplete) {
            await container.agentIdentity.releaseLegacyUpgrade({
              legacyUserId: legacy.sub,
              credentialId: result.credentialId,
              transferLeaseId: result.transferLeaseId,
            });
          }
        }
      }
      return agentIdentityResponse(
        ctx,
        startedAt,
        "upgrade",
        upgradeLegacyAgentCredentialOperation.output.parse(result),
        { status: 201 }
      );
    } catch (error) {
      const response = agentIdentityErrorResponse(
        ctx,
        startedAt,
        "upgrade",
        error
      );
      if (response) return response;
      throw error;
    }
  }
);
