// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/authorization-core`
 * Purpose: Shared AuthorizationPort contract, OpenFGA mapping helpers, OpenFGA adapter, and deterministic fake.
 * Scope: Pure package boundary for node-template-based RBAC. Does not load runtime env or select node adapters.
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
  | "node.flight"
  | "node.manage_secrets"
  | "node.promote_production"
  | "node.manage_envs";

export const AUTHZ_ACTIONS = [
  "tool.execute",
  "connection.use",
  "graph.invoke",
  "user.act_as",
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

export interface AuthorizationPort {
  check(params: AuthzCheckParams): Promise<AuthzDecision>;
  writeRelation(tuple: AuthzRelationTuple): Promise<AuthzWriteDecision>;
  deleteRelation(tuple: AuthzRelationTuple): Promise<AuthzWriteDecision>;
}

export interface AuthzRelationTuple {
  readonly user: string;
  readonly relation: string;
  readonly object: string;
}

export type AuthzWriteDecision =
  | {
      readonly decision: "success";
      readonly code: "authz_write_success";
    }
  | {
      readonly decision: "failure";
      readonly code: "authz_write_unavailable";
      readonly reason?: string;
    };

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

export function authzNodeResource(nodeId: string): string {
  return `node:${nodeId}`;
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
  OpenFgaAuthorizationAdapter,
  type OpenFgaAuthorizationAdapterConfig,
  type OpenFgaCheckClient,
  type OpenFgaStoreClient,
  type OpenFgaWriteClient,
} from "./adapters/openfga-authorization.adapter";
export { FakeAuthorizationAdapter } from "./test/fake-authorization.adapter";
