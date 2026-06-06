// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/attribution.contracts`
 * Purpose: Validates ledger Zod schemas parse and reject correctly at the contract boundary.
 * Scope: Tests Zod schema compliance for ledger write contracts. Does not test API endpoint behavior.
 * Invariants: ALL_MATH_BIGINT — bigint input strings are parsed to bigint at the contract boundary.
 * Side-effects: none
 * Links: @/contracts/attribution.record-pool-component.v1.contract
 * @internal
 */

import { PoolComponentInputSchema } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("ledger.record-pool-component.v1 contract", () => {
  const validPayload = {
    componentId: "base_issuance",
    algorithmVersion: "config-constant-v0",
    inputsJson: { baseIssuanceCredits: "10000" },
    amountCredits: "10000",
  };

  it("parses valid amountCredits string into bigint", () => {
    const result = PoolComponentInputSchema.parse(validPayload);
    expect(result.amountCredits).toBe(10000n);
  });

  it("rejects non-numeric amountCredits", () => {
    expect(() =>
      PoolComponentInputSchema.parse({ ...validPayload, amountCredits: "abc" })
    ).toThrow(/valid integer/i);
  });

  it("rejects floating point amountCredits", () => {
    expect(() =>
      PoolComponentInputSchema.parse({
        ...validPayload,
        amountCredits: "100.50",
      })
    ).toThrow(/valid integer/i);
  });
});
