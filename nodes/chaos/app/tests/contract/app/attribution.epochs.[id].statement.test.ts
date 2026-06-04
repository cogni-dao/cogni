// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/attribution.epochs.[id].statement`
 * Purpose: Contract test for public ledger epoch statement endpoint.
 * Scope: Validates Zod output schema against representative data shapes. Does not test runtime behavior.
 * Invariants: ALL_MATH_BIGINT, consistent 200 response (statement or null).
 * Side-effects: none
 * Links: contracts/attribution.epoch-statement.v1.contract
 * @public
 */

import { epochStatementOperation } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("ledger.epoch-statement.v1 contract", () => {
  it("should validate a well-formed statement response", () => {
    const data = {
      statement: {
        id: "stmt-1",
        epochId: "1",
        finalAllocationSetHash: "abc123",
        poolTotalCredits: "10000",
        statementLines: [
          {
            claimant_key: "user:user-1",
            claimant: { kind: "user", userId: "user-1" },
            final_units: "8000",
            pool_share: "0.800000",
            credit_amount: "8000",
            receipt_ids: ["receipt-1"],
          },
        ],
        supersedesStatementId: null,
        createdAt: "2026-02-08T00:00:00.000Z",
      },
    };

    expect(() => epochStatementOperation.output.parse(data)).not.toThrow();
  });

  it("should validate null statement (no statement yet)", () => {
    const data = { statement: null };
    const parsed = epochStatementOperation.output.parse(data);
    expect(parsed.statement).toBeNull();
  });

  it("should reject bare null (must be wrapped in object)", () => {
    expect(() => epochStatementOperation.output.parse(null)).toThrow();
  });
});
