// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  type AuthorizationPort,
  type AuthzCheckParams,
  type AuthzDecision,
  authzBillingAccountResource,
  authzGrantExpiresAt,
  authzNodeAgentPrincipal,
  authzNodeUserPrincipal,
} from "@cogni/authorization-core";
import { describe, expect, it, vi } from "vitest";

import { authorizationFacadeGrantOperation } from "@/contracts/authorization-facade.v1.contract";

import {
  checkNodeBillingAccountAccess,
  mutateNodeBillingAccountAccess,
} from "./authorization-facade";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_NODE_ID = "22222222-2222-4222-8222-222222222222";
const GRANTOR_ID = "33333333-3333-4333-8333-333333333333";
const SUBJECT_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "55555555-5555-4555-8555-555555555555";
const ACCOUNT_ID = "66666666-6666-4666-8666-666666666666";
const EXPIRES_AT = "2026-11-01T00:00:00.000Z";

function allow(): AuthzDecision {
  return { decision: "allow", code: "authz_allowed", checks: [] };
}

function deny(): AuthzDecision {
  return { decision: "deny", code: "authz_denied", checks: [] };
}

function authorizationWith(
  check: (params: AuthzCheckParams) => Promise<AuthzDecision>
): AuthorizationPort {
  return {
    check: vi.fn(check),
    writeRelation: vi.fn(async () => ({
      decision: "success",
      code: "authz_write_success",
    })),
    deleteRelation: vi.fn(async () => ({
      decision: "success",
      code: "authz_write_success",
    })),
    writeRelations: vi.fn(async () => ({
      decision: "success",
      code: "authz_write_success",
    })),
    deleteRelations: vi.fn(async () => ({
      decision: "success",
      code: "authz_write_success",
    })),
  };
}

describe("authorization facade policy", () => {
  it("maps direct and OBO reads into node-qualified OpenFGA checks", async () => {
    const authorization = authorizationWith(async () => allow());
    await checkNodeBillingAccountAccess({ authorization }, NODE_ID, {
      actor: { kind: "agent", id: AGENT_ID },
      subjectUserId: SUBJECT_ID,
      billingAccountId: ACCOUNT_ID,
      context: { runId: "run-1", toolCallId: "tool-1" },
    });

    expect(authorization.check).toHaveBeenCalledWith({
      actorId: authzNodeAgentPrincipal(NODE_ID, AGENT_ID),
      subjectId: authzNodeUserPrincipal(NODE_ID, SUBJECT_ID),
      action: "billing_account.read",
      resource: authzBillingAccountResource(NODE_ID, ACCOUNT_ID),
      context: {
        tenantId: ACCOUNT_ID,
        nodeId: NODE_ID,
        runId: "run-1",
        toolCallId: "tool-1",
      },
    });
  });

  it("refuses mutation before any write when the exact grantor lacks can_grant", async () => {
    const authorization = authorizationWith(async () => deny());
    await expect(
      mutateNodeBillingAccountAccess({ authorization }, NODE_ID, {
        operation: "grant",
        grantorUserId: GRANTOR_ID,
        billingAccountId: ACCOUNT_ID,
        target: { kind: "user", id: SUBJECT_ID },
        role: "reader",
        expiresAt: EXPIRES_AT,
      })
    ).resolves.toMatchObject({
      decision: "failure",
      code: "authz_write_denied",
    });
    expect(authorization.writeRelations).not.toHaveBeenCalled();
  });

  it("writes only one conditioned same-node reader tuple and requests higher consistency", async () => {
    const authorization = authorizationWith(async () => allow());
    await mutateNodeBillingAccountAccess(
      { authorization, now: () => new Date("2026-10-09T00:00:00.000Z") },
      NODE_ID,
      {
        operation: "grant",
        grantorUserId: GRANTOR_ID,
        billingAccountId: ACCOUNT_ID,
        target: { kind: "user", id: SUBJECT_ID },
        role: "reader",
        expiresAt: EXPIRES_AT,
      }
    );

    expect(authorization.writeRelations).toHaveBeenCalledWith(
      [
        {
          user: authzNodeUserPrincipal(NODE_ID, SUBJECT_ID),
          relation: "reader",
          object: authzBillingAccountResource(NODE_ID, ACCOUNT_ID),
          condition: authzGrantExpiresAt(EXPIRES_AT),
        },
      ],
      { confirm: "higher_consistency" }
    );
  });

  it("requires both pre-existing OBO legs, then writes only the account-scoped delegate", async () => {
    const seen: AuthzCheckParams[] = [];
    const authorization = authorizationWith(async (params) => {
      seen.push(params);
      return allow();
    });
    await mutateNodeBillingAccountAccess(
      { authorization, now: () => new Date("2026-10-09T00:00:00.000Z") },
      NODE_ID,
      {
        operation: "grant",
        grantorUserId: GRANTOR_ID,
        billingAccountId: ACCOUNT_ID,
        target: { kind: "agent", id: AGENT_ID },
        role: "obo",
        subjectUserId: SUBJECT_ID,
        expiresAt: EXPIRES_AT,
      }
    );

    expect(seen.map((check) => check.action)).toEqual([
      "billing_account.grant",
      "billing_account.read",
      "user.act_as",
    ]);
    expect(authorization.writeRelations).toHaveBeenCalledWith(
      [
        {
          user: authzNodeAgentPrincipal(NODE_ID, AGENT_ID),
          relation: "delegate",
          object: authzBillingAccountResource(NODE_ID, ACCOUNT_ID),
          condition: authzGrantExpiresAt(EXPIRES_AT),
        },
      ],
      { confirm: "higher_consistency" }
    );
  });

  it("revokes the exact account-scoped OBO edge without deleting global delegation", async () => {
    const authorization = authorizationWith(async () => allow());
    await mutateNodeBillingAccountAccess({ authorization }, NODE_ID, {
      operation: "revoke",
      grantorUserId: GRANTOR_ID,
      billingAccountId: ACCOUNT_ID,
      target: { kind: "agent", id: AGENT_ID },
      role: "obo",
      subjectUserId: SUBJECT_ID,
    });

    expect(authorization.deleteRelations).toHaveBeenCalledWith(
      [
        {
          user: authzNodeAgentPrincipal(NODE_ID, AGENT_ID),
          relation: "delegate",
          object: authzBillingAccountResource(NODE_ID, ACCOUNT_ID),
        },
      ],
      { confirm: "higher_consistency" }
    );
  });

  it("strictly rejects foreign/node-qualified IDs and raw tuple fields", () => {
    const base = {
      operation: "grant",
      grantorUserId: GRANTOR_ID,
      billingAccountId: ACCOUNT_ID,
      target: { kind: "agent", id: AGENT_ID },
      role: "obo",
      subjectUserId: SUBJECT_ID,
      expiresAt: EXPIRES_AT,
    } as const;
    expect(
      authorizationFacadeGrantOperation.input.safeParse({
        ...base,
        nodeId: OTHER_NODE_ID,
      }).success
    ).toBe(false);
    expect(
      authorizationFacadeGrantOperation.input.safeParse({
        ...base,
        target: {
          kind: "agent",
          id: authzNodeAgentPrincipal(OTHER_NODE_ID, AGENT_ID),
        },
      }).success
    ).toBe(false);
    expect(
      authorizationFacadeGrantOperation.input.safeParse({
        ...base,
        relation: "owner",
        object: `node:${OTHER_NODE_ID}`,
      }).success
    ).toBe(false);
  });
});
