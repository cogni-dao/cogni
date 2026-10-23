// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/authorization/billing-account-policy`
 * Purpose: Operator-local policy for its own human→agent billing-account grants and initial owner bootstrap.
 * Scope: Pure orchestration over the operator's own AuthorizationPort; no HTTP, credentials, or remote callers.
 *   Nodes never call the operator to authorize (node-capability-grants-standard); this serves only the operator node.
 * Invariants: NODE_NAMESPACE_FROM_COMPOSITION_ROOT; GRANTOR_CAN_GRANT; SEMANTIC_TUPLES_ONLY; HIGHER_CONSISTENCY.
 * Side-effects: OpenFGA IO through the injected port.
 * Links: docs/spec/rbac.md, https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import {
  type AgentAccountAccessMutationInput,
  type AuthorizationPort,
  type AuthzRelationTuple,
  type AuthzWriteDecision,
  authzBillingAccountResource,
  authzGrantExpiresAt,
  authzNodeAgentPrincipal,
  authzNodeUserPrincipal,
  type BillingAccountOwnerBootstrapInput,
} from "@cogni/authorization-core";

export interface BillingAccountPolicyDeps {
  readonly authorization: AuthorizationPort;
  readonly now?: () => Date;
}

function denied(reason: string): AuthzWriteDecision {
  return { decision: "failure", code: "authz_write_denied", reason };
}

function unavailable(reason: string): AuthzWriteDecision {
  return { decision: "failure", code: "authz_write_unavailable", reason };
}

const MAX_AGENT_ACCOUNT_GRANT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Perform the normal human-governed account ceremony. Direct access writes one
 * conditioned reader edge. OBO access atomically writes the human→agent
 * delegation and the account-scoped delegate edge, so a half-grant is never
 * visible. Callers supply only semantic IDs; raw tuples stay here.
 */
export async function mutateNodeAgentAccountAccess(
  deps: BillingAccountPolicyDeps,
  nodeId: string,
  input: AgentAccountAccessMutationInput
): Promise<AuthzWriteDecision> {
  const account = authzBillingAccountResource(nodeId, input.billingAccountId);
  const grantor = authzNodeUserPrincipal(nodeId, input.grantorUserId);
  const agent = authzNodeAgentPrincipal(nodeId, input.agentActorId);
  const grantorDecision = await deps.authorization.check(
    {
      actorId: grantor,
      action: "billing_account.grant",
      resource: account,
      context: { tenantId: input.billingAccountId, nodeId },
    },
    { consistency: "higher_consistency" }
  );
  if (grantorDecision.decision !== "allow") {
    return grantorDecision.code === "authz_unavailable"
      ? unavailable("grantor authority check unavailable")
      : denied("grantor lacks can_grant on this billing account");
  }

  let accountTuple: AuthzRelationTuple;
  if (input.operation === "grant") {
    const expiresAt = Date.parse(input.expiresAt);
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= nowMs ||
      expiresAt - nowMs > MAX_AGENT_ACCOUNT_GRANT_MS
    ) {
      return denied("grant expiry must be within the next 30 days");
    }
    accountTuple = {
      user: agent,
      relation: input.mode === "direct" ? "reader" : "delegate",
      object: account,
      condition: authzGrantExpiresAt(input.expiresAt),
    } as const;
  } else {
    accountTuple = {
      user: agent,
      relation: input.mode === "direct" ? "reader" : "delegate",
      object: account,
    } as const;
  }

  const tuples =
    input.mode === "on_behalf_of"
      ? [
          {
            user: agent,
            relation: "delegates",
            object: grantor,
          } as const,
          accountTuple,
        ]
      : [accountTuple];

  return input.operation === "grant"
    ? deps.authorization.writeRelationsAtomically(tuples, {
        confirm: "higher_consistency",
      })
    : deps.authorization.deleteRelations(tuples, {
        confirm: "higher_consistency",
      });
}

/**
 * Project the initial account owner from the operator's authoritative account
 * row. This intentionally performs no can_grant check: the owner tuple is the
 * bootstrap root that creates can_grant. The composition root supplies the
 * node namespace, and the semantic input cannot express any other relation.
 */
export async function bootstrapNodeBillingAccountOwner(
  deps: BillingAccountPolicyDeps,
  nodeId: string,
  input: BillingAccountOwnerBootstrapInput
): Promise<AuthzWriteDecision> {
  return deps.authorization.writeRelations(
    [
      {
        user: authzNodeUserPrincipal(nodeId, input.ownerUserId),
        relation: "owner",
        object: authzBillingAccountResource(nodeId, input.billingAccountId),
      },
    ],
    { confirm: "higher_consistency" }
  );
}
