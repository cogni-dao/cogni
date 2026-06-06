// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/core/attribution/rules`
 * Purpose: Unit tests for statement item computation with BIGINT arithmetic and largest-remainder rounding.
 * Scope: Pure business logic testing. Does not test external dependencies or I/O.
 * Invariants: ALL_MATH_BIGINT, STATEMENT_DETERMINISTIC — sum of statement items === poolTotalCredits.
 * Side-effects: none
 * Links: src/core/attribution/rules.ts, docs/spec/attribution-ledger.md#statement-item-computation
 * @public
 */

import type { FinalizedAllocation } from "@cogni/attribution-ledger";
import { computeStatementItems } from "@cogni/attribution-ledger";
import { describe, expect, it } from "vitest";

describe("core/ledger/rules", () => {
  describe("computeStatementItems", () => {
    it("returns empty array for no receipts", () => {
      const result = computeStatementItems([], 1000n);
      expect(result).toEqual([]);
    });

    it("returns empty array for zero pool", () => {
      const receipts: FinalizedAllocation[] = [
        { userId: "user-a", valuationUnits: 100n },
      ];
      const result = computeStatementItems(receipts, 0n);
      expect(result).toEqual([]);
    });

    it("returns empty array when all units are zero", () => {
      const receipts: FinalizedAllocation[] = [
        { userId: "user-a", valuationUnits: 0n },
        { userId: "user-b", valuationUnits: 0n },
      ];
      const result = computeStatementItems(receipts, 1000n);
      expect(result).toEqual([]);
    });

    it("gives entire pool to single recipient with share = 1.000000", () => {
      const receipts: FinalizedAllocation[] = [
        { userId: "user-a", valuationUnits: 50n },
      ];
      const result = computeStatementItems(receipts, 1000n);

      expect(result).toHaveLength(1);
      expect(result[0]?.userId).toBe("user-a");
      expect(result[0]?.totalUnits).toBe(50n);
      expect(result[0]?.amountCredits).toBe(1000n);
      expect(result[0]?.share).toBe("1.000000");
    });

    it("distributes exact division evenly with share = 0.500000", () => {
      const receipts: FinalizedAllocation[] = [
        { userId: "user-a", valuationUnits: 50n },
        { userId: "user-b", valuationUnits: 50n },
      ];
      const result = computeStatementItems(receipts, 1000n);

      expect(result).toHaveLength(2);
      expect(result[0]?.amountCredits).toBe(500n);
      expect(result[0]?.share).toBe("0.500000");
      expect(result[1]?.amountCredits).toBe(500n);
      expect(result[1]?.share).toBe("0.500000");

      const total = result.reduce((s, r) => s + r.amountCredits, 0n);
      expect(total).toBe(1000n);
    });

    it("applies largest-remainder rounding when division is inexact", () => {
      // 3 users with equal units, pool of 100 → 33, 33, 34
      const receipts: FinalizedAllocation[] = [
        { userId: "user-a", valuationUnits: 1n },
        { userId: "user-b", valuationUnits: 1n },
        { userId: "user-c", valuationUnits: 1n },
      ];
      const result = computeStatementItems(receipts, 100n);

      expect(result).toHaveLength(3);
      const total = result.reduce((s, r) => s + r.amountCredits, 0n);
      expect(total).toBe(100n);

      // Each gets floor(100/3) = 33, residual = 1
      // All have equal remainder, tie-broken by userId alphabetically
      const amounts = result.map((r) => r.amountCredits);
      expect(amounts).toContain(34n);
      expect(amounts).toContain(33n);
    });

    it("aggregates multiple receipts per user", () => {
      const receipts: FinalizedAllocation[] = [
        { userId: "user-a", valuationUnits: 30n },
        { userId: "user-a", valuationUnits: 20n },
        { userId: "user-b", valuationUnits: 50n },
      ];
      const result = computeStatementItems(receipts, 1000n);

      expect(result).toHaveLength(2);
      // user-a: 50 units, user-b: 50 units → 500 each
      expect(result[0]?.userId).toBe("user-a");
      expect(result[0]?.totalUnits).toBe(50n);
      expect(result[0]?.amountCredits).toBe(500n);
      expect(result[1]?.userId).toBe("user-b");
      expect(result[1]?.amountCredits).toBe(500n);
    });

    it("handles large values without overflow", () => {
      // Simulate realistic credits: 10 million credits (10^7 * 10^6 micro-credits)
      const pool = 10_000_000_000_000n; // 10M in micro-credits
      const receipts: FinalizedAllocation[] = [
        { userId: "user-a", valuationUnits: 7500n },
        { userId: "user-b", valuationUnits: 2500n },
      ];
      const result = computeStatementItems(receipts, pool);

      expect(result[0]?.amountCredits).toBe(7_500_000_000_000n);
      expect(result[1]?.amountCredits).toBe(2_500_000_000_000n);

      const total = result.reduce((s, r) => s + r.amountCredits, 0n);
      expect(total).toBe(pool);
    });

    it("is deterministic — same inputs produce identical output", () => {
      const receipts: FinalizedAllocation[] = [
        { userId: "user-c", valuationUnits: 7n },
        { userId: "user-a", valuationUnits: 3n },
        { userId: "user-b", valuationUnits: 5n },
      ];
      const pool = 997n;

      const run1 = computeStatementItems(receipts, pool);
      const run2 = computeStatementItems(receipts, pool);

      expect(run1).toEqual(run2);
    });

    it("sorts output by userId for determinism", () => {
      const receipts: FinalizedAllocation[] = [
        { userId: "zeta", valuationUnits: 1n },
        { userId: "alpha", valuationUnits: 1n },
        { userId: "mu", valuationUnits: 1n },
      ];
      const result = computeStatementItems(receipts, 100n);

      expect(result.map((r) => r.userId)).toEqual(["alpha", "mu", "zeta"]);
    });

    it("sum of statement items always equals pool total (STATEMENT_DETERMINISTIC)", () => {
      // Pathological case: 7 users, prime pool
      const receipts: FinalizedAllocation[] = Array.from(
        { length: 7 },
        (_, i) => ({
          userId: `user-${String(i).padStart(2, "0")}`,
          valuationUnits: BigInt(i + 1),
        })
      );
      const pool = 9973n; // prime number

      const result = computeStatementItems(receipts, pool);
      const total = result.reduce((s, r) => s + r.amountCredits, 0n);
      expect(total).toBe(pool);
    });

    it("computes share correctly for thirds", () => {
      const receipts: FinalizedAllocation[] = [
        { userId: "user-a", valuationUnits: 1n },
        { userId: "user-b", valuationUnits: 2n },
      ];
      const result = computeStatementItems(receipts, 300n);

      // user-a: 1/3 → 0.333333, user-b: 2/3 → 0.666666
      expect(result[0]?.share).toBe("0.333333");
      expect(result[1]?.share).toBe("0.666666");
    });

    it("computes share correctly for 75/25 split", () => {
      const receipts: FinalizedAllocation[] = [
        { userId: "user-a", valuationUnits: 75n },
        { userId: "user-b", valuationUnits: 25n },
      ];
      const result = computeStatementItems(receipts, 1000n);

      expect(result[0]?.share).toBe("0.750000");
      expect(result[1]?.share).toBe("0.250000");
    });

    it("distributes remainder to users with largest fractional parts", () => {
      // user-a: 1 unit, user-b: 2 units. Pool = 10
      // user-a floor = 10/3 = 3, remainder = 10%3 = 1 (remainder/total = 1/3)
      // user-b floor = 20/3 = 6, remainder = 20%3 = 2 (remainder/total = 2/3)
      // Residual = 10 - 3 - 6 = 1 → goes to user-b (larger remainder)
      const receipts: FinalizedAllocation[] = [
        { userId: "user-a", valuationUnits: 1n },
        { userId: "user-b", valuationUnits: 2n },
      ];
      const result = computeStatementItems(receipts, 10n);

      expect(result[0]?.userId).toBe("user-a");
      expect(result[0]?.amountCredits).toBe(3n);
      expect(result[1]?.userId).toBe("user-b");
      expect(result[1]?.amountCredits).toBe(7n);
    });

    it("throws on negative valuationUnits", () => {
      const receipts: FinalizedAllocation[] = [
        { userId: "user-a", valuationUnits: 10n },
        { userId: "user-b", valuationUnits: -5n },
      ];
      expect(() => computeStatementItems(receipts, 100n)).toThrow(RangeError);
    });
  });
});
