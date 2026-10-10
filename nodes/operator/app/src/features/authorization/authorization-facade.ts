// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/authorization/authorization-facade`
 * Purpose: Operator policy for node-scoped billing-account authorization checks and grants.
 * Scope: Pure orchestration over the trusted AuthorizationPort; no HTTP or credential handling.
 * Invariants: NODE_NAMESPACE_FROM_CALLER; GRANTOR_CAN_GRANT; SEMANTIC_TUPLES_ONLY; HIGHER_CONSISTENCY.
 * Side-effects: OpenFGA IO through the injected port.
 * Links: task.5226, docs/spec/rbac.md
 * @public
 */

import {
  type AuthorizationPort,
  type AuthzDecision,
  type AuthzWriteDecision,
  authzBillingAccountResource,
  authzGrantExpiresAt,
  authzNodeAgentPrincipal,
  authzNodeUserPrincipal,
} from "@cogni/authorization-core";

import type {
  AuthorizationFacadeCheckInput,
  AuthorizationFacadeGrantInput,
} from "@/contracts/authorization-facade.v1.contract";

export interface AuthorizationFacadePolicyDeps {
  readonly authorization: AuthorizationPort;
  readonly now?: () => Date;
}

function denied(reason: string): AuthzWriteDecision {
  return { decision: "failure", code: "authz_write_denied", reason };
}

function unavailable(reason: string): AuthzWriteDecision {
  return { decision: "failure", code: "authz_write_unavailable", reason };
}

function principal(
  nodeId: string,
  target: AuthorizationFacadeGrantInput["target"]
): string {
  return target.kind === "agent"
    ? authzNodeAgentPrincipal(nodeId, target.id)
    : authzNodeUserPrincipal(nodeId, target.id);
}

export async function checkNodeBillingAccountAccess(
  deps: AuthorizationFacadePolicyDeps,
  nodeId: string,
  input: AuthorizationFacadeCheckInput
): Promise<AuthzDecision> {
  return deps.authorization.check({
    actorId:
      input.actor.kind === "agent"
        ? authzNodeAgentPrincipal(nodeId, input.actor.id)
        : authzNodeUserPrincipal(nodeId, input.actor.id),
    ...(input.subjectUserId !== undefined
      ? {
          subjectId: authzNodeUserPrincipal(nodeId, input.subjectUserId),
        }
      : {}),
    action: "billing_account.read",
    resource: authzBillingAccountResource(nodeId, input.billingAccountId),
    context: {
      tenantId: input.billingAccountId,
      nodeId,
      ...(input.context?.runId !== undefined
        ? { runId: input.context.runId }
        : {}),
      ...(input.context?.toolCallId !== undefined
        ? { toolCallId: input.context.toolCallId }
        : {}),
    },
  });
}

/**
 * Apply one bounded semantic grant/revoke. OBO administration mutates only the
 * account-scoped `delegate` edge. The subject's account read edge and the agent's
 * global user-delegation edge must already exist and are checked before grant.
 * An account owner therefore cannot manufacture global human impersonation rights.
 */
export async function mutateNodeBillingAccountAccess(
  deps: AuthorizationFacadePolicyDeps,
  nodeId: string,
  input: AuthorizationFacadeGrantInput
): Promise<AuthzWriteDecision> {
  const account = authzBillingAccountResource(nodeId, input.billingAccountId);
  const grantor = authzNodeUserPrincipal(nodeId, input.grantorUserId);
  const grantorDecision = await deps.authorization.check({
    actorId: grantor,
    action: "billing_account.grant",
    resource: account,
    context: { tenantId: input.billingAccountId, nodeId },
  });
  if (grantorDecision.decision !== "allow") {
    return grantorDecision.code === "authz_unavailable"
      ? unavailable("grantor authority check unavailable")
      : denied("grantor lacks can_grant on this billing account");
  }

  if (input.operation === "grant") {
    const expiresAt = Date.parse(input.expiresAt);
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
      return denied("grant expiry must be in the future");
    }
  }

  if (input.operation === "grant" && input.role === "obo") {
    const subjectUserId = input.subjectUserId;
    if (subjectUserId === undefined || input.target.kind !== "agent") {
      return denied("invalid OBO grant");
    }

    const subject = authzNodeUserPrincipal(nodeId, subjectUserId);
    const agent = authzNodeAgentPrincipal(nodeId, input.target.id);
    const [subjectRead, userDelegation] = await Promise.all([
      deps.authorization.check({
        actorId: subject,
        action: "billing_account.read",
        resource: account,
        context: { tenantId: input.billingAccountId, nodeId },
      }),
      deps.authorization.check({
        actorId: agent,
        action: "user.act_as",
        resource: subject,
        context: { tenantId: input.billingAccountId, nodeId },
      }),
    ]);
    if (
      subjectRead.code === "authz_unavailable" ||
      userDelegation.code === "authz_unavailable"
    ) {
      return unavailable("OBO prerequisite check unavailable");
    }
    if (
      subjectRead.decision !== "allow" ||
      userDelegation.decision !== "allow"
    ) {
      return denied(
        "OBO requires existing subject account access and human-to-agent delegation"
      );
    }
  }

  const relation = input.role === "reader" ? "reader" : "delegate";
  const tuple = {
    user: principal(nodeId, input.target),
    relation,
    object: account,
    ...(input.operation === "grant"
      ? { condition: authzGrantExpiresAt(input.expiresAt) }
      : {}),
  } as const;

  return input.operation === "grant"
    ? deps.authorization.writeRelations([tuple], {
        confirm: "higher_consistency",
      })
    : deps.authorization.deleteRelations([tuple], {
        confirm: "higher_consistency",
      });
}
