// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/core/attribution/hashing`
 * Purpose: Unit tests for allocation set hashing.
 * Scope: Pure function testing. Does not test external dependencies or I/O.
 * Invariants: STATEMENT_DETERMINISTIC — same inputs → identical hash.
 * Side-effects: none
 * Links: packages/attribution-ledger/src/hashing.ts, docs/spec/attribution-ledger.md
 * @public
 */

import { computeAllocationSetHash } from "@cogni/attribution-ledger";
import { describe, expect, it } from "vitest";

describe("core/ledger/hashing", () => {
  describe("computeAllocationSetHash", () => {
    it("returns consistent hash for same allocations", async () => {
      const allocations = [
        { userId: "user-a", valuationUnits: 100n },
        { userId: "user-b", valuationUnits: 200n },
      ];

      const hash1 = await computeAllocationSetHash(allocations);
      const hash2 = await computeAllocationSetHash(allocations);
      expect(hash1).toBe(hash2);
    });

    it("is order-independent (sorts by userId)", async () => {
      const forward = [
        { userId: "user-a", valuationUnits: 100n },
        { userId: "user-b", valuationUnits: 200n },
      ];
      const reversed = [
        { userId: "user-b", valuationUnits: 200n },
        { userId: "user-a", valuationUnits: 100n },
      ];

      const hash1 = await computeAllocationSetHash(forward);
      const hash2 = await computeAllocationSetHash(reversed);
      expect(hash1).toBe(hash2);
    });

    it("produces different hash for different values", async () => {
      const a = [{ userId: "user-a", valuationUnits: 100n }];
      const b = [{ userId: "user-a", valuationUnits: 200n }];

      const hashA = await computeAllocationSetHash(a);
      const hashB = await computeAllocationSetHash(b);
      expect(hashA).not.toBe(hashB);
    });

    it("returns hex string of 64 characters (SHA-256)", async () => {
      const hash = await computeAllocationSetHash([
        { userId: "user-a", valuationUnits: 1n },
      ]);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("handles empty allocations", async () => {
      const hash = await computeAllocationSetHash([]);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
