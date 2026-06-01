// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/attribution-ledger/hash-parity`
 * Purpose: Verifies that the sign-data and finalizeEpoch code paths produce identical finalAllocationSetHash.
 * Scope: Pure unit test exercising the same function pipeline used by both endpoints. Does not test HTTP routes or database queries.
 * Invariants:
 *   - HASH_PARITY: sign-data and finalizeEpoch must produce identical finalAllocationSetHash for the same inputs
 *   - DETERMINISTIC: same inputs always produce same hash
 * Side-effects: none
 * Links: src/app/api/v1/attribution/epochs/[id]/sign-data/route.ts,
 *         services/scheduler-worker/src/activities/ledger.ts,
 *         packages/attribution-ledger/src/claimant-shares.ts,
 *         packages/attribution-ledger/src/hashing.ts
 * @internal
 */

import {
  computeFinalClaimantAllocationSetHash,
  computeReceiptWeights,
  explodeToClaimants,
  type ReceiptClaimantsRecord,
  type ReceiptForWeighting,
} from "@cogni/attribution-ledger";
import { describe, expect, it } from "vitest";

/**
 * Shared test data — mirrors what seedReviewEpoch creates in the DB.
 * Both sign-data and finalizeEpoch start from this same data shape.
 */
const WEIGHT_CONFIG: Record<string, number> = {
  "github:pr_merged": 8000,
  "github:review_submitted": 2000,
};

const ALGO_REF = "weight-sum-v0";

const TEST_RECEIPTS: ReceiptForWeighting[] = [
  {
    receiptId: "receipt-1",
    source: "github",
    eventType: "pr_merged",
    included: true,
    weightOverrideMilli: null,
  },
  {
    receiptId: "receipt-2",
    source: "github",
    eventType: "review_submitted",
    included: true,
    weightOverrideMilli: null,
  },
];

const TEST_CLAIMANTS: ReceiptClaimantsRecord[] = [
  {
    id: "c1",
    nodeId: "node-1",
    epochId: 1n,
    receiptId: "receipt-1",
    status: "locked",
    resolverRef: "cogni.default-author.v0",
    algoRef: "default-author-v0",
    inputsHash: "ih-1",
    claimantKeys: ["user:user-1"],
    createdAt: new Date("2026-03-03T00:00:00Z"),
    createdBy: "system",
  },
  {
    id: "c2",
    nodeId: "node-1",
    epochId: 1n,
    receiptId: "receipt-2",
    status: "locked",
    resolverRef: "cogni.default-author.v0",
    algoRef: "default-author-v0",
    inputsHash: "ih-2",
    claimantKeys: ["user:user-2"],
    createdAt: new Date("2026-03-04T00:00:00Z"),
    createdBy: "system",
  },
];

/**
 * Simulate the exact pipeline used by both sign-data route and finalizeEpoch activity:
 *   1. Compute receipt weights from algo + config
 *   2. Explode to claimant allocations from weights + locked claimants
 *   3. Compute final allocation set hash
 */
async function computeHash(
  receipts: readonly ReceiptForWeighting[],
  claimants: readonly ReceiptClaimantsRecord[],
  weightConfig: Record<string, number>
): Promise<string> {
  const receiptWeights = computeReceiptWeights(
    ALGO_REF,
    receipts,
    weightConfig
  );
  const allocations = explodeToClaimants(receiptWeights, claimants);
  return computeFinalClaimantAllocationSetHash(allocations);
}

describe("finalAllocationSetHash parity (sign-data ↔ finalizeEpoch)", () => {
  it("produces identical hash when called twice with same inputs (deterministic)", async () => {
    const hash1 = await computeHash(
      TEST_RECEIPTS,
      TEST_CLAIMANTS,
      WEIGHT_CONFIG
    );
    const hash2 = await computeHash(
      TEST_RECEIPTS,
      TEST_CLAIMANTS,
      WEIGHT_CONFIG
    );
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hash when weight config changes", async () => {
    const original = await computeHash(
      TEST_RECEIPTS,
      TEST_CLAIMANTS,
      WEIGHT_CONFIG
    );
    const modified = await computeHash(TEST_RECEIPTS, TEST_CLAIMANTS, {
      "github:pr_merged": 5000,
      "github:review_submitted": 5000,
    });
    expect(original).not.toBe(modified);
  });

  it("produces different hash when claimants change", async () => {
    const original = await computeHash(
      TEST_RECEIPTS,
      TEST_CLAIMANTS,
      WEIGHT_CONFIG
    );
    const altClaimants: ReceiptClaimantsRecord[] = [
      { ...TEST_CLAIMANTS[0], claimantKeys: ["user:user-99"] },
      TEST_CLAIMANTS[1],
    ];
    const modified = await computeHash(
      TEST_RECEIPTS,
      altClaimants,
      WEIGHT_CONFIG
    );
    expect(original).not.toBe(modified);
  });

  it("produces different hash when receipts differ", async () => {
    const original = await computeHash(
      TEST_RECEIPTS,
      TEST_CLAIMANTS,
      WEIGHT_CONFIG
    );
    const fewerReceipts: ReceiptForWeighting[] = [TEST_RECEIPTS[0]];
    const fewerClaimants: ReceiptClaimantsRecord[] = [TEST_CLAIMANTS[0]];
    const modified = await computeHash(
      fewerReceipts,
      fewerClaimants,
      WEIGHT_CONFIG
    );
    expect(original).not.toBe(modified);
  });

  it("hash is a valid SHA-256 hex string", async () => {
    const hash = await computeHash(
      TEST_RECEIPTS,
      TEST_CLAIMANTS,
      WEIGHT_CONFIG
    );
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash.length).toBe(64);
  });
});
