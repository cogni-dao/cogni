// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/attribution.epochs.[id].distribution`
 * Purpose: Contract test for the public epoch distribution claim endpoint (merkle leaf + proof).
 * Scope: Validates the Zod output schema against representative shapes. Does not test runtime behavior.
 * Invariants: ALL_MATH_BIGINT (amount string), PROOF_HEX_ARRAY, DISTRIBUTOR_NULLABLE, NO_SECRETS.
 * Side-effects: none
 * Links: contracts/attribution.epoch-distribution.v1.contract
 * @public
 */

import { epochDistributionOperation } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("ledger.epoch-distribution.v1 contract", () => {
  it("should validate a well-formed claim response", () => {
    const data = {
      claim: {
        epochId: "1",
        root: "0x9f00000000000000000000000000000000000000000000000000000000000000",
        distributor: "0x717a747df71111a678202BfCD2E3B0081A9aeB56",
        chainId: 8453,
        tokenAddress: "0x0166Db3d42603E790Fb685059DcAa37087B032c8",
        index: 3,
        account: "0x1111111111111111111111111111111111111111",
        amount: "1000000000000000000",
        proof: [
          "0xabc0000000000000000000000000000000000000000000000000000000000000",
          "0xdef0000000000000000000000000000000000000000000000000000000000000",
        ],
      },
    };

    expect(() => epochDistributionOperation.output.parse(data)).not.toThrow();
  });

  it("should validate a claim with a not-yet-deployed (null) distributor", () => {
    const data = {
      claim: {
        epochId: "1",
        root: "0x9f00000000000000000000000000000000000000000000000000000000000000",
        distributor: null,
        chainId: 8453,
        tokenAddress: "0x0166Db3d42603E790Fb685059DcAa37087B032c8",
        index: 0,
        account: "0x2222222222222222222222222222222222222222",
        amount: "5000000000000000000",
        proof: [],
      },
    };

    const parsed = epochDistributionOperation.output.parse(data);
    expect(parsed.claim?.distributor).toBeNull();
  });

  it("should validate null claim (no manifest or no leaf for account)", () => {
    const data = { claim: null };
    const parsed = epochDistributionOperation.output.parse(data);
    expect(parsed.claim).toBeNull();
  });

  it("should reject bare null (must be wrapped in object)", () => {
    expect(() => epochDistributionOperation.output.parse(null)).toThrow();
  });
});
