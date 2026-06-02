// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/attribution.epochs.[id].user-projections`
 * Purpose: Contract test for public ledger epoch user projections endpoint.
 * Scope: Validates Zod output schema against representative data shapes. Does not test runtime behavior.
 * Invariants: ALL_MATH_BIGINT, PUBLIC_READS_FINALIZED_ONLY.
 * Side-effects: none
 * Links: contracts/attribution.epoch-user-projections.v1.contract
 * @public
 */

import { epochUserProjectionsOperation } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("ledger.epoch-user-projections.v1 contract", () => {
  it("should validate a well-formed user projections response", () => {
    const data = {
      userProjections: [
        {
          id: "alloc-1",
          userId: "user-uuid",
          projectedUnits: "8000",
          receiptCount: 12,
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-02T00:00:00.000Z",
        },
      ],
      epochId: "1",
    };

    expect(() =>
      epochUserProjectionsOperation.output.parse(data)
    ).not.toThrow();
  });

  it("should require the projectedUnits and receiptCount shape", () => {
    const data = {
      userProjections: [
        {
          id: "alloc-2",
          userId: "user-uuid",
          projectedUnits: "5000",
          receiptCount: 3,
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
      epochId: "2",
    };

    const parsed = epochUserProjectionsOperation.output.parse(data);
    expect(parsed.userProjections[0].projectedUnits).toBe("5000");
  });
});
