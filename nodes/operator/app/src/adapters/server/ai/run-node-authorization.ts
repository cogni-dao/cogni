// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/ai/run-node-authorization`
 * Purpose: Bind operator node-role checks to a run's canonical users.id principal.
 * Scope: Thin host composition over AuthorizationPort; no model, grant or tuple changes.
 * Invariants: Principal authority AND existing subject permission/delegation; requester never supplies principal authority.
 * Side-effects: IO (existing authorization checks only).
 * Links: hub agent-run-authority, human-ai-identity-standard, story.0085
 * @internal
 */
import type { AuthorizationPort } from "@cogni/authorization-core";

export function withRunNodeAuthorization(
  authorization: AuthorizationPort,
  principalId: string | undefined
): AuthorizationPort {
  return {
    async check(params) {
      // Non-node policies retain their existing principal/reference semantics.
      if (!params.action.startsWith("node."))
        return authorization.check(params);
      if (!principalId || params.actorId !== `agent:${principalId}`)
        return {
          decision: "deny",
          code: "authz_denied",
          checks: [],
          reason: "Run principal required",
        };
      // Role writers grant user:<users.id>. Delegation instead requires agent:<id>.
      // These are two checks of the SAME principal, never interchangeable FGA refs.
      const principal = await authorization.check({
        actorId: `user:${principalId}`,
        action: params.action,
        resource: params.resource,
        context: params.context,
      });
      if (principal.decision !== "allow" || !params.subjectId) return principal;
      const delegated = await authorization.check(params);
      return {
        ...delegated,
        checks: [...principal.checks, ...delegated.checks],
      };
    },
    writeRelation: authorization.writeRelation.bind(authorization),
    deleteRelation: authorization.deleteRelation.bind(authorization),
    listRelations: authorization.listRelations.bind(authorization),
    listRelationsByObject:
      authorization.listRelationsByObject.bind(authorization),
  };
}
