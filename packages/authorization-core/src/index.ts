// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/authorization-core`
 * Purpose: Shared AuthorizationPort contract, OpenFGA mapping helpers, and deterministic fake.
 * Scope: Portable package boundary for node-template-based RBAC. Does not expose a raw OpenFGA client.
 * Invariants: OpenFGA is the sole permission/delegation source; deny by default; unavailable fails closed with a distinct code.
 * Side-effects: none
 * Links: docs/spec/rbac.md, docs/spec/access-control-charter.md
 * @public
 */

export type AuthzAction =
  | "tool.execute"
  | "connection.use"
  | "graph.invoke"
  | "user.act_as"
  | "billing_account.read"
  | "billing_account.grant"
  | "billing_account.act_as"
  | "node.flight"
  | "node.manage_secrets"
  | "node.promote_production"
  | "node.manage_envs";

export const AUTHZ_ACTIONS = [
  "tool.execute",
  "connection.use",
  "graph.invoke",
  "user.act_as",
  "billing_account.read",
  "billing_account.grant",
  "billing_account.act_as",
  "node.flight",
  "node.manage_secrets",
  "node.promote_production",
  "node.manage_envs",
] as const satisfies readonly AuthzAction[];

export type AuthzDecisionCode =
  | "authz_allowed"
  | "authz_denied"
  | "authz_unavailable";

export interface AuthzContext {
  readonly tenantId: string;
  readonly nodeId?: string;
  readonly graphId?: string;
  readonly runId?: string;
  readonly toolCallId?: string;
}

export interface AuthzCheckParams {
  readonly actorId: string;
  readonly subjectId?: string;
  readonly action: AuthzAction;
  readonly resource: string;
  readonly context: AuthzContext;
}

export interface AuthzCheckOptions {
  /** Read the latest tuple state for authority-bearing mutation preconditions. */
  readonly consistency?: "higher_consistency";
}

export interface AuthzSubcheck {
  readonly name: "permission" | "delegation";
  readonly user: string;
  readonly relation: string;
  readonly object: string;
  readonly decision: "allow" | "deny";
  readonly code: AuthzDecisionCode;
}

export type AuthzDecision =
  | {
      readonly decision: "allow";
      readonly code: "authz_allowed";
      readonly checks: readonly AuthzSubcheck[];
    }
  | {
      readonly decision: "deny";
      readonly code: "authz_denied" | "authz_unavailable";
      readonly checks: readonly AuthzSubcheck[];
      readonly reason?: string;
    };

/** Read-only authorization boundary safe for independently governed nodes. */
export interface AuthorizationCheckPort {
  check(
    params: AuthzCheckParams,
    options?: AuthzCheckOptions
  ): Promise<AuthzDecision>;
}

/** Raw relation mutation boundary. Trusted operator code only. */
export interface AuthorizationRelationAdminPort {
  writeRelation(
    tuple: AuthzRelationTuple,
    options?: AuthzMutationOptions
  ): Promise<AuthzWriteDecision>;
  deleteRelation(
    tuple: AuthzRelationTuple,
    options?: AuthzMutationOptions
  ): Promise<AuthzWriteDecision>;
  writeRelations(
    tuples: readonly AuthzRelationTuple[],
    options?: AuthzMutationOptions
  ): Promise<AuthzWriteDecision>;
  deleteRelations(
    tuples: readonly AuthzRelationTuple[],
    options?: AuthzMutationOptions
  ): Promise<AuthzWriteDecision>;
  /** Atomically replace one tuple key, including its relationship condition. */
  replaceRelation(
    tuple: AuthzRelationTuple,
    options?: AuthzMutationOptions
  ): Promise<AuthzWriteDecision>;
}

/** Full operator-internal authorization boundary. */
export interface AuthorizationPort
  extends AuthorizationCheckPort,
    AuthorizationRelationAdminPort {}

export interface AuthzRelationCondition {
  readonly name: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface AuthzRelationTuple {
  readonly user: string;
  readonly relation: string;
  readonly object: string;
  readonly condition?: AuthzRelationCondition;
}

export interface AuthzMutationOptions {
  /**
   * Confirm the post-mutation relation state through OpenFGA's
   * HIGHER_CONSISTENCY read path before reporting success.
   */
  readonly confirm?: "higher_consistency";
}

export type AuthzWriteDecision =
  | {
      readonly decision: "success";
      readonly code: "authz_write_success";
    }
  | {
      readonly decision: "failure";
      readonly code: "authz_write_denied" | "authz_write_unavailable";
      readonly reason?: string;
    };

export type BillingAccountGrantRole = "reader" | "obo";

export type BillingAccountGrantTarget =
  | { readonly kind: "user"; readonly id: string }
  | { readonly kind: "agent"; readonly id: string };

export interface BillingAccountGrantInput {
  /** Same-node human asserted by the node backend; operator verifies can_grant. */
  readonly grantorUserId: string;
  readonly billingAccountId: string;
  readonly target: BillingAccountGrantTarget;
  readonly role: BillingAccountGrantRole;
  /** Required for an OBO bundle; omitted for a direct reader grant. */
  readonly subjectUserId?: string;
  /** Required for grants; ignored for revocation. */
  readonly expiresAt: string;
  readonly requestId?: string;
}

export interface BillingAccountRevokeInput {
  /** Same-node human asserted by the node backend; operator verifies can_grant. */
  readonly grantorUserId: string;
  readonly billingAccountId: string;
  readonly target: BillingAccountGrantTarget;
  readonly role: BillingAccountGrantRole;
  /** Required for an OBO bundle; omitted for a direct reader revoke. */
  readonly subjectUserId?: string;
  readonly requestId?: string;
}

/**
 * Semantic account-grant boundary. It cannot express owner, node-role, or arbitrary
 * relation writes; the operator independently verifies the grantor's can_grant edge.
 */
export interface BillingAccountGrantAdministrationPort {
  grantBillingAccountAccess(
    input: BillingAccountGrantInput
  ): Promise<AuthzWriteDecision>;
  revokeBillingAccountAccess(
    input: BillingAccountRevokeInput
  ): Promise<AuthzWriteDecision>;
}

export function authzToolResource(toolId: string): string {
  return `tool:${toolId}`;
}

export function authzConnectionResource(connectionId: string): string {
  return `connection:${connectionId}`;
}

export function authzGraphResource(graphId: string): string {
  return `graph:${graphId}`;
}

export function authzUserResource(userId: string): string {
  return userId.startsWith("user:") ? userId : `user:${userId}`;
}

/**
 * Qualify node-local identities before they enter the env-shared OpenFGA store.
 * The node segment is a namespace boundary only; it does not imply ownership.
 */
export function authzNodeUserPrincipal(nodeId: string, userId: string): string {
  return nodeScopedReference("user", nodeId, userId);
}

export function authzNodeAgentPrincipal(
  nodeId: string,
  actorId: string
): string {
  return nodeScopedReference("agent", nodeId, actorId);
}

export function authzBillingAccountResource(
  nodeId: string,
  billingAccountId: string
): string {
  return nodeScopedReference("billing_account", nodeId, billingAccountId);
}

export function authzNodeResource(nodeId: string): string {
  return `node:${nodeId}`;
}

export const AUTHZ_GRANT_NOT_EXPIRED_CONDITION = "grant_not_expired";

export function authzGrantExpiresAt(expiresAt: string): AuthzRelationCondition {
  return {
    name: AUTHZ_GRANT_NOT_EXPIRED_CONDITION,
    context: { expires_at: expiresAt },
  };
}

function nodeScopedReference(
  type: "user" | "agent" | "billing_account",
  nodeId: string,
  localId: string
): string {
  // OpenFGA permits exactly one ':' in an object/user reference. Keep the
  // node-local components inside the opaque ID with '/' as their delimiter.
  assertReferenceComponent("nodeId", nodeId);
  const prefix = `${type}:${nodeId}/`;
  if (localId.startsWith(prefix)) {
    assertReferenceComponent("localId", localId.slice(prefix.length));
    return localId;
  }

  const typePrefix = `${type}:`;
  if (localId.startsWith(typePrefix)) {
    throw new Error(`${type} reference belongs to a different node namespace`);
  }

  assertReferenceComponent("localId", localId);
  return `${prefix}${localId}`;
}

function assertReferenceComponent(name: string, value: string): void {
  if (value.length === 0 || value.includes(":") || value.includes("/")) {
    throw new Error(`${name} must be a non-empty node-local identifier`);
  }
}

export function relationForAuthzAction(action: AuthzAction): string {
  switch (action) {
    case "tool.execute":
      return "can_execute";
    case "connection.use":
      return "can_use";
    case "graph.invoke":
      return "can_invoke";
    case "user.act_as":
      return "delegates";
    case "billing_account.read":
      return "can_read";
    case "billing_account.grant":
      return "can_grant";
    case "billing_account.act_as":
      return "can_act_as";
    case "node.flight":
      return "can_flight";
    case "node.manage_secrets":
      return "can_manage_secrets";
    case "node.promote_production":
      return "can_promote_production";
    case "node.manage_envs":
      return "can_manage_envs";
  }
}

export {
  AUTHORIZATION_FACADE_TOKEN_PREFIX,
  authorizationFacadeCredentialFromToken,
  authorizationFacadeNodeIdFromToken,
  RemoteAuthorizationAdapter,
  type AuthorizationFacadeCredentialIdentity,
  type RemoteAuthorizationAdapterConfig,
} from "./adapters/remote-authorization.adapter";
export { FakeAuthorizationAdapter } from "./test/fake-authorization.adapter";
