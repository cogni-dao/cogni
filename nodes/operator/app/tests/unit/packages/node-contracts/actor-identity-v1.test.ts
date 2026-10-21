// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/packages/node-contracts/actor-identity-v1`
 * Purpose: Lock the direct three-principal beneficiary acceptance contract.
 * Scope: Pure schema validation; no route, database, or identity I/O.
 * Invariants: DIRECT_ROLE_ACCEPTANCE; NO_GOVERNANCE_SUBSTITUTION.
 * Side-effects: none
 * Links: story.5075, attribution.actor-identity.v1.contract
 * @internal
 */

import { actorBeneficiaryPolicyOperation } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("actor beneficiary policy acceptance contract", () => {
  const acceptance = {
    action: "accept" as const,
    proposalId: "proposal-1",
    evidence: { ceremony: "direct-principal-proof" },
  };

  it.each([
    "beneficiary",
    "earner",
    "steward",
  ] as const)("accepts the direct %s role", (role) => {
    expect(
      actorBeneficiaryPolicyOperation.input.safeParse({
        ...acceptance,
        role,
      }).success
    ).toBe(true);
  });

  it.each([
    "governance_for_earner",
    "governance_for_steward",
  ])("rejects removed governance substitution role %s", (role) => {
    expect(
      actorBeneficiaryPolicyOperation.input.safeParse({
        ...acceptance,
        role,
      }).success
    ).toBe(false);
  });
});
