// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/attribution/claimants.server`
 * Purpose: Verifies readFinalizedEpochClaimants three-tier fallback behavior with mocked store.
 * Scope: Covers statement → final allocations → locked claimants + receipt weights paths. Does not test database I/O.
 * Invariants: ENRICHER_IDEMPOTENT, CLAIMANT_RESOLUTION_REQUIRED.
 * Side-effects: none
 * Links: src/app/_facades/attribution/claimants.server.ts
 * @internal
 */

import type { AttributionStore } from "@cogni/attribution-ledger";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ attributionStore: mockStore }),
}));

let mockStore: AttributionStore;

import { readFinalizedEpochClaimants } from "@/app/_facades/attribution/claimants.server";

const NODE_ID = "aaaaaaaa-0000-0000-0000-000000000001";

const baseEpoch = {
  id: 1n,
  nodeId: NODE_ID,
  scopeId: "bbbbbbbb-0000-0000-0000-000000000001",
  status: "finalized" as const,
  periodStart: new Date("2026-02-17T00:00:00Z"),
  periodEnd: new Date("2026-02-24T00:00:00Z"),
  weightConfig: { "github:pr_merged": 1000 },
  poolTotalCredits: 10000n,
  approverSetHash: "hash",
  allocationAlgoRef: "weight-sum-v0",
  weightConfigHash: "wc-hash",
  artifactsHash: "art-hash",
  openedAt: new Date("2026-02-17T00:00:00Z"),
  closedAt: new Date("2026-02-24T00:00:00Z"),
  createdAt: new Date("2026-02-17T00:00:00Z"),
};

function makeStore(
  overrides: Partial<AttributionStore> = {}
): AttributionStore {
  return {
    createEpoch: vi.fn(),
    getOpenEpoch: vi.fn(),
    getEpochByWindow: vi.fn(),
    getEpoch: vi.fn().mockResolvedValue(baseEpoch),
    listEpochs: vi.fn(),
    closeIngestion: vi.fn(),
    closeIngestionWithEvaluations: vi.fn(),
    finalizeEpoch: vi.fn(),
    upsertDraftEvaluation: vi.fn(),
    getEvaluationsForEpoch: vi.fn(),
    getEvaluation: vi.fn().mockResolvedValue(null),
    getSelectedReceiptsForAttribution: vi.fn().mockResolvedValue([]),
    getSelectedReceiptsWithMetadata: vi.fn(),
    insertIngestionReceipts: vi.fn(),
    getReceiptsForWindow: vi.fn().mockResolvedValue([]),
    upsertSelection: vi.fn(),
    getSelectionForEpoch: vi.fn(),
    getUnresolvedSelection: vi.fn(),
    insertUserProjections: vi.fn(),
    upsertUserProjections: vi.fn(),
    deleteStaleUserProjections: vi.fn(),
    getUserProjectionsForEpoch: vi.fn(),
    replaceFinalClaimantAllocations: vi.fn(),
    getFinalClaimantAllocationsForEpoch: vi.fn().mockResolvedValue([]),
    getSelectedReceiptsForAllocation: vi.fn().mockResolvedValue([]),
    upsertCursor: vi.fn(),
    getCursor: vi.fn(),
    insertPoolComponent: vi
      .fn()
      .mockResolvedValue({ component: {}, created: true }),
    getPoolComponentsForEpoch: vi.fn(),
    insertEpochStatement: vi.fn(),
    getStatementForEpoch: vi.fn().mockResolvedValue(null),
    insertStatementSignature: vi.fn(),
    getSignaturesForStatement: vi.fn(),
    insertSelectionDoNothing: vi.fn(),
    resolveIdentities: vi.fn().mockResolvedValue(new Map()),
    getUserDisplayNames: vi.fn().mockResolvedValue(new Map()),
    finalizeEpochAtomic: vi.fn(),
    getSelectionCandidates: vi.fn(),
    updateSelectionUserId: vi.fn(),
    upsertReviewSubjectOverride: vi.fn(),
    batchUpsertReviewSubjectOverrides: vi.fn(),
    deleteReviewSubjectOverride: vi.fn(),
    getReviewSubjectOverridesForEpoch: vi.fn(),
    upsertDraftClaimants: vi.fn(),
    lockClaimantsForEpoch: vi.fn(),
    loadLockedClaimants: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as AttributionStore;
}

describe("readFinalizedEpochClaimants", () => {
  it("uses locked claimants + receipt weights when no statement or final allocations exist", async () => {
    mockStore = makeStore({
      loadLockedClaimants: vi.fn().mockResolvedValue([
        {
          id: "c1",
          nodeId: NODE_ID,
          epochId: 1n,
          receiptId: "receipt-1",
          status: "locked",
          resolverRef: "cogni.default-author.v0",
          algoRef: "default-author-v0",
          inputsHash: "ih-1",
          claimantKeys: ["user:user-1"],
          createdAt: new Date(),
          createdBy: "system",
        },
      ]),
      getSelectedReceiptsForAllocation: vi.fn().mockResolvedValue([
        {
          receiptId: "receipt-1",
          userId: "user-1",
          source: "github",
          eventType: "pr_merged",
          included: true,
          weightOverrideMilli: null,
        },
      ]),
    });

    const result = await readFinalizedEpochClaimants(1n);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].claimantKey).toBe("user:user-1");
    expect(result.poolTotalCredits).toBe("10000");
    expect(mockStore.loadLockedClaimants).toHaveBeenCalledWith(1n);
    expect(mockStore.getSelectedReceiptsForAllocation).toHaveBeenCalledWith(1n);
  });

  it("prefers statement lines when statement exists", async () => {
    mockStore = makeStore({
      getStatementForEpoch: vi.fn().mockResolvedValue({
        id: "stmt-1",
        nodeId: NODE_ID,
        epochId: 1n,
        finalAllocationSetHash: "hash",
        poolTotalCredits: 10000n,
        statementLines: [
          {
            claimant_key: "user:user-1",
            claimant: { kind: "user", userId: "user-1" },
            final_units: "1000",
            pool_share: "1.000000",
            credit_amount: "10000",
            receipt_ids: ["receipt-1"],
          },
        ],
        reviewOverridesJson: null,
        supersedesStatementId: null,
        createdAt: new Date(),
      }),
    });

    const result = await readFinalizedEpochClaimants(1n);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].claimantKey).toBe("user:user-1");
    // Should NOT fall through to loadLockedClaimants
    expect(mockStore.loadLockedClaimants).not.toHaveBeenCalled();
  });

  it("throws for non-finalized epochs", async () => {
    mockStore = makeStore({
      getEpoch: vi.fn().mockResolvedValue({ ...baseEpoch, status: "open" }),
    });

    await expect(readFinalizedEpochClaimants(1n)).rejects.toThrow(
      "expected 'finalized'"
    );
  });
});
