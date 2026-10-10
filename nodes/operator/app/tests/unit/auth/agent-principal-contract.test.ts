// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  agentRequestPrincipalSchema,
  executionIdentitySchema,
  humanRequestPrincipalSchema,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

const NODE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const BILLING_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";

describe("node-qualified principal contracts", () => {
  it("accepts canonical principals bound to their local identity", () => {
    expect(
      agentRequestPrincipalSchema.safeParse({
        kind: "agent",
        principalId: `agent:${NODE_ID}/${ACTOR_ID}`,
        actorId: ACTOR_ID,
        credentialId: "33333333-3333-4333-8333-333333333333",
        billingAccountId: BILLING_ACCOUNT_ID,
        displayName: "flock-leader",
        legacyUserId: null,
      }).success
    ).toBe(true);
    expect(
      humanRequestPrincipalSchema.safeParse({
        kind: "human",
        principalId: `user:${NODE_ID}/${USER_ID}`,
        userId: USER_ID,
        walletAddress: null,
        displayName: null,
        avatarColor: null,
      }).success
    ).toBe(true);
  });

  it("rejects a principal whose suffix disagrees with its actor", () => {
    expect(
      agentRequestPrincipalSchema.safeParse({
        kind: "agent",
        principalId: `agent:${NODE_ID}/${USER_ID}`,
        actorId: ACTOR_ID,
        credentialId: "33333333-3333-4333-8333-333333333333",
        billingAccountId: BILLING_ACCOUNT_ID,
        displayName: null,
        legacyUserId: null,
      }).success
    ).toBe(false);
  });

  it("rejects nested-colon and non-UUID shared-store subjects", () => {
    expect(
      executionIdentitySchema.safeParse({
        actorPrincipal: `agent:${NODE_ID}:${ACTOR_ID}`,
        subjectPrincipal: null,
        billingAccountId: BILLING_ACCOUNT_ID,
        grantId: null,
      }).success
    ).toBe(false);
    expect(
      executionIdentitySchema.safeParse({
        actorPrincipal: `agent:node-1/${ACTOR_ID}`,
        subjectPrincipal: null,
        billingAccountId: BILLING_ACCOUNT_ID,
        grantId: null,
      }).success
    ).toBe(false);
  });

  it("rejects cross-node on-behalf-of identities", () => {
    const otherNodeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expect(
      executionIdentitySchema.safeParse({
        actorPrincipal: `agent:${NODE_ID}/${ACTOR_ID}`,
        subjectPrincipal: `user:${otherNodeId}/${USER_ID}`,
        billingAccountId: BILLING_ACCOUNT_ID,
        grantId: null,
      }).success
    ).toBe(false);
  });
});
