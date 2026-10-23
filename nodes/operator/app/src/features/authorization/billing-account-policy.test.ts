// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  type AuthorizationPort,
  type AuthzCheckParams,
  type AuthzDecision,
  type AuthzWriteDecision,
  authzBillingAccountResource,
  authzGrantExpiresAt,
  authzNodeAgentPrincipal,
  authzNodeUserPrincipal,
} from "@cogni/authorization-core";
import { describe, expect, it, vi } from "vitest";

import {
  bootstrapNodeBillingAccountOwner,
  mutateNodeAgentAccountAccess,
} from "./billing-account-policy";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const GRANTOR_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "55555555-5555-4555-8555-555555555555";
const ACCOUNT_ID = "66666666-6666-4666-8666-666666666666";

function allow(): AuthzDecision {
  return { decision: "allow", code: "authz_allowed", checks: [] };
}

function deny(): AuthzDecision {
  return { decision: "deny", code: "authz_denied", checks: [] };
}

async function writeSuccess(): Promise<AuthzWriteDecision> {
  return { decision: "success", code: "authz_write_success" };
}

function authorizationWith(
  check: (params: AuthzCheckParams) => Promise<AuthzDecision>
): AuthorizationPort {
  return {
    check: vi.fn(check),
    writeRelation: vi.fn(writeSuccess),
    deleteRelation: vi.fn(writeSuccess),
    writeRelations: vi.fn(writeSuccess),
    writeRelationsAtomically: vi.fn(writeSuccess),
    deleteRelations: vi.fn(writeSuccess),
    replaceRelation: vi.fn(writeSuccess),
    listRelations: vi.fn(async () => ({
      decision: "success" as const,
      code: "authz_list_success" as const,
      tuples: [],
    })),
  };
}

describe("operator billing-account policy", () => {
  it("bootstraps only the exact node-qualified owner at higher consistency", async () => {
    const authorization = authorizationWith(async () => allow());

    await expect(
      bootstrapNodeBillingAccountOwner({ authorization }, NODE_ID, {
        ownerUserId: GRANTOR_ID,
        billingAccountId: ACCOUNT_ID,
        requestId: "req-1",
      })
    ).resolves.toEqual({
      decision: "success",
      code: "authz_write_success",
    });
    expect(authorization.writeRelations).toHaveBeenCalledWith(
      [
        {
          user: authzNodeUserPrincipal(NODE_ID, GRANTOR_ID),
          relation: "owner",
          object: authzBillingAccountResource(NODE_ID, ACCOUNT_ID),
        },
      ],
      { confirm: "higher_consistency" }
    );
  });

  it("refuses mutation after just-revoked grantor authority at higher consistency", async () => {
    const authorization = authorizationWith(async () => deny());
    await expect(
      mutateNodeAgentAccountAccess({ authorization }, NODE_ID, {
        operation: "grant",
        grantorUserId: GRANTOR_ID,
        billingAccountId: ACCOUNT_ID,
        agentActorId: AGENT_ID,
        mode: "direct",
        expiresAt: "2026-10-20T00:00:00.000Z",
      })
    ).resolves.toMatchObject({
      decision: "failure",
      code: "authz_write_denied",
    });
    expect(authorization.writeRelationsAtomically).not.toHaveBeenCalled();
    expect(authorization.check).toHaveBeenCalledWith(
      expect.objectContaining({ action: "billing_account.grant" }),
      { consistency: "higher_consistency" }
    );
  });

  it("atomically grants the human delegation and exact-account OBO edge", async () => {
    const authorization = authorizationWith(async () => allow());
    await mutateNodeAgentAccountAccess(
      { authorization, now: () => new Date("2026-10-15T00:00:00.000Z") },
      NODE_ID,
      {
        operation: "grant",
        grantorUserId: GRANTOR_ID,
        billingAccountId: ACCOUNT_ID,
        agentActorId: AGENT_ID,
        mode: "on_behalf_of",
        expiresAt: "2026-10-20T00:00:00.000Z",
      }
    );

    expect(authorization.writeRelationsAtomically).toHaveBeenCalledWith(
      [
        {
          user: authzNodeAgentPrincipal(NODE_ID, AGENT_ID),
          relation: "delegates",
          object: authzNodeUserPrincipal(NODE_ID, GRANTOR_ID),
        },
        {
          user: authzNodeAgentPrincipal(NODE_ID, AGENT_ID),
          relation: "delegate",
          object: authzBillingAccountResource(NODE_ID, ACCOUNT_ID),
          condition: authzGrantExpiresAt("2026-10-20T00:00:00.000Z"),
        },
      ],
      { confirm: "higher_consistency" }
    );
  });

  it("revokes both OBO legs atomically and rejects overlong grants", async () => {
    const authorization = authorizationWith(async () => allow());
    await mutateNodeAgentAccountAccess({ authorization }, NODE_ID, {
      operation: "revoke",
      grantorUserId: GRANTOR_ID,
      billingAccountId: ACCOUNT_ID,
      agentActorId: AGENT_ID,
      mode: "on_behalf_of",
    });
    expect(authorization.deleteRelations).toHaveBeenCalledWith(
      [
        {
          user: authzNodeAgentPrincipal(NODE_ID, AGENT_ID),
          relation: "delegates",
          object: authzNodeUserPrincipal(NODE_ID, GRANTOR_ID),
        },
        {
          user: authzNodeAgentPrincipal(NODE_ID, AGENT_ID),
          relation: "delegate",
          object: authzBillingAccountResource(NODE_ID, ACCOUNT_ID),
        },
      ],
      { confirm: "higher_consistency" }
    );

    await expect(
      mutateNodeAgentAccountAccess(
        { authorization, now: () => new Date("2026-10-15T00:00:00.000Z") },
        NODE_ID,
        {
          operation: "grant",
          grantorUserId: GRANTOR_ID,
          billingAccountId: ACCOUNT_ID,
          agentActorId: AGENT_ID,
          mode: "direct",
          expiresAt: "2026-12-01T00:00:00.000Z",
        }
      )
    ).resolves.toMatchObject({
      decision: "failure",
      code: "authz_write_denied",
    });
  });
});
