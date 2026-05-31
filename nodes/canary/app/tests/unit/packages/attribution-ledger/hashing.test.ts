// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/attribution-ledger/hashing`
 * Purpose: Unit tests for computeAllocationSetHash and computeWeightConfigHash.
 * Scope: Asserts determinism, canonical ordering, and hash stability. Does not test store or I/O.
 * Invariants: STATEMENT_DETERMINISTIC.
 * Side-effects: none
 * Links: packages/attribution-ledger/src/hashing.ts
 * @internal
 */

import {
  computeAllocationSetHash,
  computeFinalClaimantAllocationSetHash,
  computeWeightConfigHash,
} from "@cogni/attribution-ledger";
import { describe, expect, it } from "vitest";

describe("computeAllocationSetHash", () => {
  it("produces deterministic hash for same allocations", async () => {
    const allocs = [
      { userId: "bob", valuationUnits: 2000n },
      { userId: "alice", valuationUnits: 1000n },
    ];
    const h1 = await computeAllocationSetHash(allocs);
    const h2 = await computeAllocationSetHash(allocs);
    expect(h1).toBe(h2);
  });

  it("produces same hash regardless of input order", async () => {
    const h1 = await computeAllocationSetHash([
      { userId: "bob", valuationUnits: 2000n },
      { userId: "alice", valuationUnits: 1000n },
    ]);
    const h2 = await computeAllocationSetHash([
      { userId: "alice", valuationUnits: 1000n },
      { userId: "bob", valuationUnits: 2000n },
    ]);
    expect(h1).toBe(h2);
  });

  it("produces different hash for different allocations", async () => {
    const h1 = await computeAllocationSetHash([
      { userId: "alice", valuationUnits: 1000n },
    ]);
    const h2 = await computeAllocationSetHash([
      { userId: "alice", valuationUnits: 2000n },
    ]);
    expect(h1).not.toBe(h2);
  });

  it("handles empty allocations", async () => {
    const hash = await computeAllocationSetHash([]);
    expect(hash).toBeTruthy();
    expect(hash).toHaveLength(64); // SHA-256 hex
  });
});

describe("computeWeightConfigHash", () => {
  it("produces deterministic hash for same config", async () => {
    const config = { "github:pr_merged": 1000, "github:review_submitted": 500 };
    const h1 = await computeWeightConfigHash(config);
    const h2 = await computeWeightConfigHash(config);
    expect(h1).toBe(h2);
  });

  it("produces same hash regardless of key order", async () => {
    const h1 = await computeWeightConfigHash({
      "github:review_submitted": 500,
      "github:pr_merged": 1000,
    });
    const h2 = await computeWeightConfigHash({
      "github:pr_merged": 1000,
      "github:review_submitted": 500,
    });
    expect(h1).toBe(h2);
  });

  it("produces different hash for different configs", async () => {
    const h1 = await computeWeightConfigHash({ "github:pr_merged": 1000 });
    const h2 = await computeWeightConfigHash({ "github:pr_merged": 2000 });
    expect(h1).not.toBe(h2);
  });

  it("returns 64-char hex string (SHA-256)", async () => {
    const hash = await computeWeightConfigHash({ a: 1 });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("computeFinalClaimantAllocationSetHash", () => {
  it("matches legacy allocation hashes for resolved-user-only inputs", async () => {
    const legacy = await computeAllocationSetHash([
      { userId: "alice", valuationUnits: 1000n },
      { userId: "bob", valuationUnits: 2000n },
    ]);

    const claimant = await computeFinalClaimantAllocationSetHash([
      { claimant: { kind: "user", userId: "alice" }, finalUnits: 1000n },
      { claimant: { kind: "user", userId: "bob" }, finalUnits: 2000n },
    ]);

    expect(claimant).toBe(legacy);
  });

  it("includes identity claimants in canonical order", async () => {
    const a = await computeFinalClaimantAllocationSetHash([
      {
        claimant: {
          kind: "identity",
          provider: "github",
          externalId: "42",
          providerLogin: "alice",
        },
        finalUnits: 1000n,
      },
      { claimant: { kind: "user", userId: "bob" }, finalUnits: 500n },
    ]);

    const b = await computeFinalClaimantAllocationSetHash([
      { claimant: { kind: "user", userId: "bob" }, finalUnits: 500n },
      {
        claimant: {
          kind: "identity",
          provider: "github",
          externalId: "42",
          providerLogin: "alice",
        },
        finalUnits: 1000n,
      },
    ]);

    expect(a).toBe(b);
  });
});
