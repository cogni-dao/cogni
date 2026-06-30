// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/enrichment-activities.test`
 * Purpose: Verifies evaluateEpochDraft and buildLockedEvaluations activity behavior — profile-driven enricher dispatch, payload structure, idempotency, and Temporal wire-format safety.
 * Scope: Covers echo enricher (cogni.echo.v0) dispatched via cogni-v0.0 profile with mocked store. Does NOT cover workflow orchestration or DB integration.
 * Invariants:
 * - ENRICHER_IDEMPOTENT: Same receipts produce same hashes across draft and locked runs.
 * - BIGINT_WIRE_SAFE: buildLockedEvaluations output survives JSON.stringify (no BigInt in wire format).
 * - PROFILE_DISPATCH: enrichers are dispatched via attributionPipeline → profile → enricherRefs.
 * Side-effects: none (mocked store)
 * Links: services/scheduler-worker/src/activities/enrichment.ts
 * @internal
 */

import type {
  AttributionStore,
  SelectedReceiptForAttribution,
  SelectedReceiptWithMetadata,
} from "@cogni/attribution-ledger";
import {
  createDefaultRegistries,
  ECHO_ALGO_REF,
  ECHO_EVALUATION_REF,
} from "@cogni/attribution-pipeline-plugins";
import { describe, expect, it, vi } from "vitest";

import { createEnrichmentActivities } from "../src/activities/enrichment.js";

const NODE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ATTRIBUTION_PIPELINE = "cogni-v0.0";

const registries = createDefaultRegistries();

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as unknown as Parameters<typeof createEnrichmentActivities>[0]["logger"];

function makeMockStore(
  overrides: Partial<AttributionStore> = {}
): AttributionStore {
  return {
    createEpoch: vi.fn(),
    getOpenEpoch: vi.fn().mockResolvedValue(null),
    getEpochByWindow: vi.fn().mockResolvedValue(null),
    getEpoch: vi.fn(),
    listEpochs: vi.fn(),
    closeIngestion: vi.fn(),
    closeIngestionWithEvaluations: vi.fn(),
    transitionEpochForWindow: vi.fn(),
    finalizeEpoch: vi.fn(),
    upsertDraftEvaluation: vi.fn(),
    getEvaluationsForEpoch: vi.fn().mockResolvedValue([]),
    getEvaluation: vi.fn().mockResolvedValue(null),
    getSelectedReceiptsForAttribution: vi.fn().mockResolvedValue([]),
    getSelectedReceiptsWithMetadata: vi.fn().mockResolvedValue([]),
    insertIngestionReceipts: vi.fn(),
    getReceiptsForWindow: vi.fn(),
    upsertSelection: vi.fn(),
    getSelectionForEpoch: vi.fn(),
    getUnresolvedSelection: vi.fn(),
    upsertDraftClaimants: vi.fn(),
    lockClaimantsForEpoch: vi.fn(),
    loadLockedClaimants: vi.fn().mockResolvedValue([]),
    insertUserProjections: vi.fn(),
    upsertUserProjections: vi.fn(),
    deleteStaleUserProjections: vi.fn(),
    getUserProjectionsForEpoch: vi.fn(),
    replaceFinalClaimantAllocations: vi.fn(),
    getFinalClaimantAllocationsForEpoch: vi.fn(),
    getUserDisplayNames: vi.fn().mockResolvedValue(new Map()),
    getSelectedReceiptsForAllocation: vi.fn().mockResolvedValue([]),
    upsertReviewSubjectOverride: vi.fn(),
    batchUpsertReviewSubjectOverrides: vi.fn().mockResolvedValue([]),
    deleteReviewSubjectOverride: vi.fn(),
    getReviewSubjectOverridesForEpoch: vi.fn().mockResolvedValue([]),
    upsertCursor: vi.fn(),
    getCursor: vi.fn().mockResolvedValue(null),
    insertPoolComponent: vi
      .fn()
      .mockResolvedValue({ component: {}, created: true }),
    getPoolComponentsForEpoch: vi.fn(),
    insertEpochStatement: vi.fn(),
    getStatementForEpoch: vi.fn(),
    insertStatementSignature: vi.fn(),
    getSignaturesForStatement: vi.fn(),
    insertSelectionDoNothing: vi.fn(),
    resolveIdentities: vi.fn().mockResolvedValue(new Map()),
    finalizeEpochAtomic: vi.fn(),
    getSelectionCandidates: vi.fn().mockResolvedValue([]),
    updateSelectionUserId: vi.fn(),
    updateSelectionIncluded: vi.fn(),
    ...overrides,
  } as AttributionStore;
}

function makeReceipts(count: number): SelectedReceiptWithMetadata[] {
  return Array.from({ length: count }, (_, i) => ({
    receiptId: `ev-${i}`,
    userId: i % 2 === 0 ? "user-aaa" : "user-bbb",
    source: "github",
    eventType: i % 3 === 0 ? "pr_merged" : "review_submitted",
    included: true,
    weightOverrideMilli: null,
    metadata: { title: `PR #${i}` },
    payloadHash: `hash-${i}`,
  }));
}

function makeAttributionReceipts(
  count: number
): SelectedReceiptForAttribution[] {
  return Array.from({ length: count }, (_, i) => ({
    receiptId: `ev-${i}`,
    userId: i % 2 === 0 ? "user-aaa" : null,
    source: "github",
    eventType: i % 3 === 0 ? "pr_merged" : "review_submitted",
    included: true,
    weightOverrideMilli: null,
    platformUserId: `gh-${i}`,
    platformLogin: `user-${i}`,
    artifactUrl: `https://github.com/test/repo/pull/${i}`,
    eventTime: new Date(`2026-02-2${i}T12:00:00Z`),
    payloadHash: `claim-hash-${i}`,
  }));
}

function makeEpoch() {
  return {
    id: 1n,
    nodeId: NODE_ID,
    scopeId: "bbbbbbbb-0000-0000-0000-000000000001",
    status: "open" as const,
    periodStart: new Date("2026-02-17T00:00:00Z"),
    periodEnd: new Date("2026-02-24T00:00:00Z"),
    weightConfig: {
      "github:pr_merged": 1000,
      "github:review_submitted": 500,
    },
    poolTotalCredits: null,
    approverSetHash: null,
    approvers: null,
    allocationAlgoRef: null,
    weightConfigHash: null,
    artifactsHash: null,
    openedAt: new Date("2026-02-17T00:00:00Z"),
    closedAt: null,
    createdAt: new Date("2026-02-17T00:00:00Z"),
  };
}

function makeActivities(storeOverrides: Partial<AttributionStore> = {}) {
  const store = makeMockStore(storeOverrides);
  const activities = createEnrichmentActivities({
    attributionStore: store,
    nodeId: NODE_ID,
    logger: mockLogger,
    registries,
  });
  return { store, activities };
}

// ── evaluateEpochDraft ────────────────────────────────────────────

describe("evaluateEpochDraft", () => {
  it("produces correct echo payload structure via profile dispatch", async () => {
    const receipts = makeReceipts(5);
    const { store, activities } = makeActivities({
      getEpoch: vi.fn().mockResolvedValue(makeEpoch()),
      getSelectedReceiptsForAttribution: vi
        .fn()
        .mockResolvedValue(makeAttributionReceipts(5)),
      getSelectedReceiptsWithMetadata: vi.fn().mockResolvedValue(receipts),
    });

    const result = await activities.evaluateEpochDraft({
      epochId: "1",
      attributionPipeline: ATTRIBUTION_PIPELINE,
    });

    expect(result.evaluationRefs).toEqual([ECHO_EVALUATION_REF]);
    expect(result.receiptCount).toBe(5);

    expect(store.upsertDraftEvaluation).toHaveBeenCalledTimes(1);

    const echoCall = vi.mocked(store.upsertDraftEvaluation).mock.calls[0][0];
    expect(echoCall.evaluationRef).toBe(ECHO_EVALUATION_REF);
    expect(echoCall.algoRef).toBe(ECHO_ALGO_REF);
    expect(echoCall.status).toBe("draft");
    expect(echoCall.nodeId).toBe(NODE_ID);
    expect(echoCall.epochId).toBe(1n);

    // Verify payload shape
    const payload = echoCall.payloadJson as {
      totalEvents: number;
      byEventType: Record<string, number>;
      byUserId: Record<string, number>;
    };
    expect(payload.totalEvents).toBe(5);
    expect(payload.byEventType).toBeDefined();
    expect(payload.byUserId).toBeDefined();
    expect(payload.byUserId["user-aaa"]).toBe(3);
    expect(payload.byUserId["user-bbb"]).toBe(2);
  });

  it("calls upsertDraftEvaluation with status='draft'", async () => {
    const { store, activities } = makeActivities({
      getEpoch: vi.fn().mockResolvedValue(makeEpoch()),
      getSelectedReceiptsForAttribution: vi
        .fn()
        .mockResolvedValue(makeAttributionReceipts(2)),
      getSelectedReceiptsWithMetadata: vi
        .fn()
        .mockResolvedValue(makeReceipts(2)),
    });

    await activities.evaluateEpochDraft({
      epochId: "1",
      attributionPipeline: ATTRIBUTION_PIPELINE,
    });

    const call = vi.mocked(store.upsertDraftEvaluation).mock.calls[0][0];
    expect(call.status).toBe("draft");
  });

  it("handles no receipts — writes evaluation with empty counts", async () => {
    const { store, activities } = makeActivities({
      getEpoch: vi.fn().mockResolvedValue(makeEpoch()),
      getSelectedReceiptsForAttribution: vi.fn().mockResolvedValue([]),
      getSelectedReceiptsWithMetadata: vi.fn().mockResolvedValue([]),
    });

    const result = await activities.evaluateEpochDraft({
      epochId: "1",
      attributionPipeline: ATTRIBUTION_PIPELINE,
    });

    expect(result.receiptCount).toBe(0);
    expect(store.upsertDraftEvaluation).toHaveBeenCalledTimes(1);

    const payload = vi.mocked(store.upsertDraftEvaluation).mock.calls[0][0]
      .payloadJson as { totalEvents: number };
    expect(payload.totalEvents).toBe(0);
  });

  it("throws on unknown attributionPipeline", async () => {
    const { activities } = makeActivities({
      getEpoch: vi.fn().mockResolvedValue(makeEpoch()),
    });

    await expect(
      activities.evaluateEpochDraft({
        epochId: "1",
        attributionPipeline: "nonexistent-profile",
      })
    ).rejects.toThrow(/nonexistent-profile/);
  });
});

// ── buildLockedEvaluations ─────────────────────────────────────────

describe("buildLockedEvaluations", () => {
  it("returns evaluations and artifactsHash without writing to store", async () => {
    const receipts = makeReceipts(3);
    const { store, activities } = makeActivities({
      getEpoch: vi.fn().mockResolvedValue(makeEpoch()),
      getSelectedReceiptsForAttribution: vi
        .fn()
        .mockResolvedValue(makeAttributionReceipts(3)),
      getSelectedReceiptsWithMetadata: vi.fn().mockResolvedValue(receipts),
    });

    const result = await activities.buildLockedEvaluations({
      epochId: "1",
      attributionPipeline: ATTRIBUTION_PIPELINE,
    });

    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0].evaluationRef).toBe(ECHO_EVALUATION_REF);
    expect(result.evaluations[0].status).toBe("locked");
    expect(result.artifactsHash).toMatch(/^[a-f0-9]{64}$/);

    // Should NOT write to store
    expect(store.upsertDraftEvaluation).not.toHaveBeenCalled();
    expect(store.closeIngestionWithEvaluations).not.toHaveBeenCalled();
  });

  it("returns valid artifactsHash", async () => {
    const { activities } = makeActivities({
      getEpoch: vi.fn().mockResolvedValue(makeEpoch()),
      getSelectedReceiptsForAttribution: vi
        .fn()
        .mockResolvedValue(makeAttributionReceipts(2)),
      getSelectedReceiptsWithMetadata: vi
        .fn()
        .mockResolvedValue(makeReceipts(2)),
    });

    const result = await activities.buildLockedEvaluations({
      epochId: "1",
      attributionPipeline: ATTRIBUTION_PIPELINE,
    });
    expect(result.artifactsHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("includes schemaRef in wire format", async () => {
    const { activities } = makeActivities({
      getEpoch: vi.fn().mockResolvedValue(makeEpoch()),
      getSelectedReceiptsWithMetadata: vi
        .fn()
        .mockResolvedValue(makeReceipts(2)),
    });

    const result = await activities.buildLockedEvaluations({
      epochId: "1",
      attributionPipeline: ATTRIBUTION_PIPELINE,
    });

    expect(result.evaluations[0].schemaRef).toBe("cogni.echo.v0/1.0.0");
  });
});

// ── Change detection (skip when inputsHash unchanged) ───────────

describe("evaluateEpochDraft change detection", () => {
  it("skips enricher when existing draft evaluation has matching inputsHash", async () => {
    const receipts = makeReceipts(3);

    // Pre-compute the inputsHash that would result from these receipts.
    // The echo adapter uses computeEnricherInputsHash with the same receipt shape.
    const { computeEnricherInputsHash } = await import(
      "@cogni/attribution-ledger"
    );
    const expectedHash = await computeEnricherInputsHash({
      epochId: 1n,
      receipts: receipts.map((r) => ({
        receiptId: r.receiptId,
        receiptPayloadHash: r.payloadHash,
      })),
    });

    const { store, activities } = makeActivities({
      getEpoch: vi.fn().mockResolvedValue(makeEpoch()),
      getSelectedReceiptsWithMetadata: vi.fn().mockResolvedValue(receipts),
      // Return an existing evaluation with the same inputsHash
      getEvaluation: vi.fn().mockResolvedValue({
        id: "eval-1",
        nodeId: NODE_ID,
        epochId: 1n,
        evaluationRef: ECHO_EVALUATION_REF,
        status: "draft",
        algoRef: ECHO_ALGO_REF,
        inputsHash: expectedHash,
        payloadHash: "old-payload-hash",
        payloadJson: {},
        payloadRef: null,
        createdAt: new Date(),
      }),
    });

    const result = await activities.evaluateEpochDraft({
      epochId: "1",
      attributionPipeline: ATTRIBUTION_PIPELINE,
    });

    // Should return the ref but NOT call the adapter or write to store
    expect(result.evaluationRefs).toEqual([ECHO_EVALUATION_REF]);
    expect(store.upsertDraftEvaluation).not.toHaveBeenCalled();
  });

  it("runs enricher when existing draft evaluation has different inputsHash", async () => {
    const receipts = makeReceipts(3);
    const { store, activities } = makeActivities({
      getEpoch: vi.fn().mockResolvedValue(makeEpoch()),
      getSelectedReceiptsWithMetadata: vi.fn().mockResolvedValue(receipts),
      // Return an existing evaluation with a STALE inputsHash
      getEvaluation: vi.fn().mockResolvedValue({
        id: "eval-1",
        nodeId: NODE_ID,
        epochId: 1n,
        evaluationRef: ECHO_EVALUATION_REF,
        status: "draft",
        algoRef: ECHO_ALGO_REF,
        inputsHash: "stale-hash-does-not-match",
        payloadHash: "old-payload-hash",
        payloadJson: {},
        payloadRef: null,
        createdAt: new Date(),
      }),
    });

    const result = await activities.evaluateEpochDraft({
      epochId: "1",
      attributionPipeline: ATTRIBUTION_PIPELINE,
    });

    expect(result.evaluationRefs).toEqual([ECHO_EVALUATION_REF]);
    expect(store.upsertDraftEvaluation).toHaveBeenCalledTimes(1);
  });

  it("runs enricher when no existing draft evaluation exists", async () => {
    const receipts = makeReceipts(3);
    const { store, activities } = makeActivities({
      getEpoch: vi.fn().mockResolvedValue(makeEpoch()),
      getSelectedReceiptsWithMetadata: vi.fn().mockResolvedValue(receipts),
      getEvaluation: vi.fn().mockResolvedValue(null),
    });

    const result = await activities.evaluateEpochDraft({
      epochId: "1",
      attributionPipeline: ATTRIBUTION_PIPELINE,
    });

    expect(result.evaluationRefs).toEqual([ECHO_EVALUATION_REF]);
    expect(store.upsertDraftEvaluation).toHaveBeenCalledTimes(1);
  });
});

// ── Idempotency ─────────────────────────────────────────────────

describe("idempotency", () => {
  it("same receipts produce same hashes across evaluateEpochDraft and buildLockedEvaluations", async () => {
    const receipts = makeReceipts(4);
    const { store, activities } = makeActivities({
      getEpoch: vi.fn().mockResolvedValue(makeEpoch()),
      getSelectedReceiptsForAttribution: vi
        .fn()
        .mockResolvedValue(makeAttributionReceipts(4)),
      getSelectedReceiptsWithMetadata: vi.fn().mockResolvedValue(receipts),
    });

    await activities.evaluateEpochDraft({
      epochId: "1",
      attributionPipeline: ATTRIBUTION_PIPELINE,
    });
    const finalResult = await activities.buildLockedEvaluations({
      epochId: "1",
      attributionPipeline: ATTRIBUTION_PIPELINE,
    });

    // Draft and final should have same payload hash and inputs hash
    const draftCall = vi.mocked(store.upsertDraftEvaluation).mock.calls[0][0];
    const finalEvaluation = finalResult.evaluations[0];

    expect(draftCall.payloadHash).toBe(finalEvaluation.payloadHash);
    expect(draftCall.inputsHash).toBe(finalEvaluation.inputsHash);

    // buildLockedEvaluations returns wire format (epochId as string, not bigint)
    expect(finalEvaluation.epochId).toBe("1");
    expect(typeof finalEvaluation.epochId).toBe("string");
  });

  it("buildLockedEvaluations output survives JSON.stringify (no BigInt regression)", async () => {
    const { activities } = makeActivities({
      getEpoch: vi.fn().mockResolvedValue(makeEpoch()),
      getSelectedReceiptsForAttribution: vi
        .fn()
        .mockResolvedValue(makeAttributionReceipts(3)),
      getSelectedReceiptsWithMetadata: vi
        .fn()
        .mockResolvedValue(makeReceipts(3)),
    });

    const result = await activities.buildLockedEvaluations({
      epochId: "999",
      attributionPipeline: ATTRIBUTION_PIPELINE,
    });

    // This is the exact operation Temporal performs on activity return values.
    // If any nested field is bigint, JSON.stringify throws TypeError.
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
