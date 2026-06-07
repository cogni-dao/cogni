// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/authorization-core/test/fake-authorization`
 * Purpose: Deterministic AuthorizationPort fake for tests that must not call OpenFGA.
 * Scope: In-memory exact-match decisions over AuthzCheckParams. Does not model local roles or production policy.
 * Invariants: Fake defaults to deny; unavailable can be configured distinctly from deny.
 * Side-effects: none
 * Links: docs/spec/rbac.md
 * @public
 */

import type {
  AuthorizationPort,
  AuthzCheckParams,
  AuthzDecision,
  AuthzDecisionCode,
  AuthzRelationTuple,
  AuthzSubcheck,
  AuthzWriteDecision,
} from "../index";
import { authzUserResource, relationForAuthzAction } from "../index";

type FakeDecision = Exclude<AuthzDecisionCode, "authz_allowed"> | "allow";

function keyFor(params: AuthzCheckParams): string {
  return JSON.stringify({
    actorId: params.actorId,
    subjectId: params.subjectId ?? null,
    action: params.action,
    resource: params.resource,
    tenantId: params.context.tenantId,
    graphId: params.context.graphId ?? null,
  });
}

function checksFor(params: AuthzCheckParams): readonly AuthzSubcheck[] {
  const permission = {
    name: "permission" as const,
    user: params.subjectId ?? params.actorId,
    relation: relationForAuthzAction(params.action),
    object: params.resource,
    decision: "deny" as const,
    code: "authz_denied" as const,
  };

  if (!params.subjectId) return [permission];

  return [
    permission,
    {
      name: "delegation",
      user: params.actorId,
      relation: relationForAuthzAction("user.act_as"),
      object: authzUserResource(params.subjectId),
      decision: "deny",
      code: "authz_denied",
    },
  ];
}

export class FakeAuthorizationAdapter implements AuthorizationPort {
  private readonly decisions = new Map<string, FakeDecision>();
  private readonly relations = new Set<string>();

  allow(params: AuthzCheckParams): void {
    this.decisions.set(keyFor(params), "allow");
  }

  deny(params: AuthzCheckParams): void {
    this.decisions.set(keyFor(params), "authz_denied");
  }

  unavailable(params: AuthzCheckParams): void {
    this.decisions.set(keyFor(params), "authz_unavailable");
  }

  async check(params: AuthzCheckParams): Promise<AuthzDecision> {
    const decision = this.decisions.get(keyFor(params)) ?? "authz_denied";
    const checks = checksFor(params);

    if (decision === "allow") {
      return {
        decision: "allow",
        code: "authz_allowed",
        checks: checks.map((check) => ({
          ...check,
          decision: "allow",
          code: "authz_allowed",
        })),
      };
    }

    return {
      decision: "deny",
      code: decision,
      checks: checks.map((check) => ({ ...check, code: decision })),
      reason:
        decision === "authz_unavailable"
          ? "Fake authz unavailable"
          : "Fake authz denied",
    };
  }

  async writeRelation(tuple: AuthzRelationTuple): Promise<AuthzWriteDecision> {
    this.relations.add(relationKey(tuple));
    return { decision: "success", code: "authz_write_success" };
  }

  async deleteRelation(tuple: AuthzRelationTuple): Promise<AuthzWriteDecision> {
    this.relations.delete(relationKey(tuple));
    return { decision: "success", code: "authz_write_success" };
  }

  hasRelation(tuple: AuthzRelationTuple): boolean {
    return this.relations.has(relationKey(tuple));
  }
}

function relationKey(tuple: AuthzRelationTuple): string {
  return JSON.stringify(tuple);
}
