// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/packages/attribution-ledger/validated-store`
 * Purpose: Verifies createValidatedAttributionStore delegates prototype methods and intercepts evaluation writes.
 * Scope: Pure unit test with mock store class. Does not perform I/O or require database infrastructure.
 * Invariants:
 * - ENVELOPE_VALIDATED_ON_WRITE: validation interceptors are called for evaluation writes.
 * - All non-intercepted methods delegate correctly to inner store (including prototype methods).
 * Side-effects: none
 * Links: packages/attribution-ledger/src/validated-store.ts
 * @internal
 */

import type { AttributionStore } from "@cogni/attribution-ledger";
import { describe, expect, it } from "vitest";
import { createValidatedAttributionStore } from "../src/validated-store";

/**
 * Minimal class-based mock that simulates DrizzleAttributionAdapter.
 * Methods are on the prototype (not own properties) — the exact scenario
 * that broke with object spread.
 */
class MockAttributionStore {
  getEpochCalled = false;
  finalizeEpochAtomicCalled = false;
  upsertDraftEvaluationCalled = false;
  closeIngestionWithEvaluationsCalled = false;

  async getEpoch(_id: bigint) {
    this.getEpochCalled = true;
    return null;
  }

  async finalizeEpochAtomic(_params: unknown) {
    this.finalizeEpochAtomicCalled = true;
    return { epoch: {} as never, statement: {} as never };
  }

  async upsertDraftEvaluation(_params: unknown) {
    this.upsertDraftEvaluationCalled = true;
  }

  async closeIngestionWithEvaluations(_params: unknown) {
    this.closeIngestionWithEvaluationsCalled = true;
    return {} as never;
  }

  // Stub remaining interface methods so TS is satisfied
  async createEpoch() {
    return {} as never;
  }
  async getOpenEpoch() {
    return null;
  }
  async getEpochByWindow() {
    return null;
  }
  async listEpochs() {
    return [];
  }
  async closeIngestion() {
    return {} as never;
  }
  async finalizeEpoch() {
    return {} as never;
  }
  async getEvaluationsForEpoch() {
    return [];
  }
  async getEvaluation() {
    return null;
  }
  async getSelectedReceiptsWithMetadata() {
    return [];
  }
  async getSelectedReceiptsForAttribution() {
    return [];
  }
  async insertIngestionReceipts() {}
  async getReceiptsForWindow() {
    return [];
  }
  async getAllReceipts() {
    return [];
  }
  async getReceiptsForEpoch() {
    return [];
  }
  async getSelectedReceiptsForAllocation() {
    return [];
  }
  async upsertSelection() {}
  async insertSelectionDoNothing() {}
  async getSelectionForEpoch() {
    return [];
  }
  async getUnresolvedSelection() {
    return [];
  }
  async insertUserProjections() {}
  async upsertUserProjections() {}
  async deleteStaleUserProjections() {}
  async getUserProjectionsForEpoch() {
    return [];
  }
  async replaceFinalClaimantAllocations() {}
  async getFinalClaimantAllocationsForEpoch() {
    return [];
  }
  async upsertCursor() {}
  async getCursor() {
    return null;
  }
  async insertPoolComponent() {
    return { component: {} as never, created: true };
  }
  async getPoolComponentsForEpoch() {
    return [];
  }
  async insertEpochStatement() {
    return {} as never;
  }
  async getStatementForEpoch() {
    return null;
  }
  async insertStatementSignature() {}
  async getSignaturesForStatement() {
    return [];
  }
  async upsertReviewSubjectOverride() {
    return {} as never;
  }
  async batchUpsertReviewSubjectOverrides() {
    return [];
  }
  async deleteReviewSubjectOverride() {}
  async getReviewSubjectOverridesForEpoch() {
    return [];
  }
  async upsertDraftClaimants() {}
  async lockClaimantsForEpoch() {
    return 0;
  }
  async loadLockedClaimants() {
    return [];
  }
  async resolveIdentities() {
    return new Map();
  }
  async getUserDisplayNames() {
    return new Map();
  }
  async getSelectionCandidates() {
    return [];
  }
  async updateSelectionUserId() {}
  async updateSelectionIncluded() {}
}

describe("createValidatedAttributionStore", () => {
  it("delegates prototype methods (regression: spread drops prototype methods)", async () => {
    const inner = new MockAttributionStore();
    const wrapped = createValidatedAttributionStore(
      inner as unknown as AttributionStore
    );

    // getEpoch is a prototype method — would be undefined with ...spread
    expect(typeof wrapped.getEpoch).toBe("function");
    await wrapped.getEpoch(1n);
    expect(inner.getEpochCalled).toBe(true);
  });

  it("delegates finalizeEpochAtomic (prototype method)", async () => {
    const inner = new MockAttributionStore();
    const wrapped = createValidatedAttributionStore(
      inner as unknown as AttributionStore
    );

    expect(typeof wrapped.finalizeEpochAtomic).toBe("function");
    await wrapped.finalizeEpochAtomic({
      epochId: 1n,
      poolTotal: 100n,
      finalClaimantAllocations: [],
      statement: {} as never,
      signature: {} as never,
      expectedFinalAllocationSetHash: "hash",
    });
    expect(inner.finalizeEpochAtomicCalled).toBe(true);
  });

  it("intercepts upsertDraftEvaluation with validation", async () => {
    const inner = new MockAttributionStore();
    const wrapped = createValidatedAttributionStore(
      inner as unknown as AttributionStore
    );

    // Should throw because evaluationRef doesn't match envelope pattern
    await expect(
      wrapped.upsertDraftEvaluation({
        nodeId: "node-1",
        epochId: 1n,
        evaluationRef: "invalid!ref",
        status: "draft",
        algoRef: "v0",
        inputsHash: "hash",
        payloadHash: "hash",
        payloadJson: {},
      })
    ).rejects.toThrow();

    // Inner should NOT have been called (validation rejected)
    expect(inner.upsertDraftEvaluationCalled).toBe(false);
  });

  it("passes through valid evaluation writes after validation", async () => {
    const inner = new MockAttributionStore();
    const wrapped = createValidatedAttributionStore(
      inner as unknown as AttributionStore
    );

    await wrapped.upsertDraftEvaluation({
      nodeId: "node-1",
      epochId: 1n,
      evaluationRef: "cogni.claimant_shares.v0",
      status: "draft",
      algoRef: "claimant-shares-v0",
      inputsHash: "a".repeat(64),
      payloadHash: "b".repeat(64),
      payloadJson: { version: 1, subjects: [] },
    });

    expect(inner.upsertDraftEvaluationCalled).toBe(true);
  });
});
