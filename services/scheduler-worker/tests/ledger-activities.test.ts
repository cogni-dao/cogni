// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/ledger-activities.test`
 * Purpose: Unit tests for ledger activity functions, epoch window computation, and materializeSelection.
 * Scope: Tests each activity in isolation with mocked store/adapter. Covers identity resolution, selection auto-population, and admin-field preservation.
 * @internal
 */

import type {
  AttributionEpoch,
  AttributionEvaluation,
  AttributionStore,
  IngestionCursor,
  UnselectedReceipt,
} from "@cogni/attribution-ledger";
import {
  computeApproverSetHash,
  computeEpochWindowV1,
} from "@cogni/attribution-ledger";
import { createDefaultRegistries } from "@cogni/attribution-pipeline-plugins";
import type {
  ActivityEvent,
  CollectResult,
  DataSourceRegistration,
} from "@cogni/ingestion-core";
import { verifyTypedData } from "viem";
import { describe, expect, it, vi } from "vitest";

vi.mock("viem", () => ({
  verifyTypedData: vi.fn(),
}));

import { createAttributionActivities } from "../src/activities/ledger.js";

const NODE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const SCOPE_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const registries = createDefaultRegistries();

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as unknown as Parameters<typeof createAttributionActivities>[0]["logger"];

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
    getAllReceipts: vi.fn().mockResolvedValue([]),
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
    getSelectedReceiptsForAllocation: vi.fn().mockResolvedValue([]),
    finalizeEpochAtomic: vi.fn(),
    getSelectionCandidates: vi.fn().mockResolvedValue([]),
    updateSelectionUserId: vi.fn(),
    upsertReviewSubjectOverride: vi.fn(),
    batchUpsertReviewSubjectOverrides: vi.fn().mockResolvedValue([]),
    deleteReviewSubjectOverride: vi.fn(),
    getReviewSubjectOverridesForEpoch: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as AttributionStore;
}

function makeMockRegistration(
  events: ActivityEvent[] = []
): DataSourceRegistration {
  return {
    source: "github",
    version: "0.3.0",
    poll: {
      streams: () => [
        {
          id: "pull_requests",
          name: "PRs",
          cursorType: "timestamp" as const,
          defaultPollInterval: 3600,
        },
      ],
      collect: vi.fn().mockResolvedValue({
        events,
        nextCursor: {
          streamId: "pull_requests",
          value: "2026-02-22T00:00:00.000Z",
          retrievedAt: new Date(),
        },
      } satisfies CollectResult),
    },
  };
}

function makeEpoch(
  overrides: Partial<AttributionEpoch> = {}
): AttributionEpoch {
  return {
    id: 1n,
    nodeId: NODE_ID,
    scopeId: SCOPE_ID,
    status: "open",
    periodStart: new Date("2026-02-16T00:00:00Z"),
    periodEnd: new Date("2026-02-23T00:00:00Z"),
    weightConfig: { "github:pr_merged": 1000 },
    poolTotalCredits: null,
    approverSetHash: null,
    approvers: null,
    allocationAlgoRef: null,
    weightConfigHash: null,
    artifactsHash: null,
    openedAt: new Date(),
    closedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeEvaluation(
  overrides: Partial<AttributionEvaluation> = {}
): AttributionEvaluation {
  return {
    id: "eval-1",
    nodeId: NODE_ID,
    epochId: 1n,
    evaluationRef: "cogni.echo.v0",
    status: "draft",
    algoRef: "echo-v0",
    inputsHash: "inputs-hash",
    payloadHash: "payload-hash",
    payloadJson: {
      totalEvents: 1,
      byEventType: { pr_merged: 1 },
      byUserId: { "user-1": 1 },
    },
    payloadRef: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeEvent(id = "github:pr:test/repo:1"): ActivityEvent {
  return {
    id,
    source: "github",
    eventType: "pr_merged",
    platformUserId: "12345",
    platformLogin: "testuser",
    artifactUrl: "https://github.com/test/repo/pull/1",
    metadata: { title: "Test PR" },
    payloadHash: "abc123",
    eventTime: new Date("2026-02-20T12:00:00Z"),
  };
}

function makeUnselectedReceipt(
  overrides: Partial<UnselectedReceipt["receipt"]> & {
    hasExistingSelection?: boolean;
  } = {}
): UnselectedReceipt {
  const { hasExistingSelection = false, ...receiptOverrides } = overrides;
  return {
    receipt: {
      receiptId: "github:pr:test/repo:1",
      nodeId: NODE_ID,
      source: "github",
      eventType: "pr_merged",
      platformUserId: "12345",
      platformLogin: "testuser",
      artifactUrl: "https://github.com/test/repo/pull/1",
      metadata: {
        title: "Test PR",
        baseBranch: "staging",
        mergeCommitSha: "abc111",
        repo: "test/repo",
      },
      payloadHash: "abc123",
      producer: "github",
      producerVersion: "0.3.0",
      eventTime: new Date("2026-02-20T12:00:00Z"),
      retrievedAt: new Date("2026-02-20T12:01:00Z"),
      ingestedAt: new Date("2026-02-20T12:02:00Z"),
      ...receiptOverrides,
    },
    hasExistingSelection,
  };
}

/**
 * Creates a release PR receipt (baseBranch=main) that promotes staging PRs
 * by including their mergeCommitShas in its commitShas array.
 */
function makeReleasePrReceipt(
  promotedShas: string[] = ["abc111"]
): UnselectedReceipt["receipt"] {
  return {
    receiptId: "github:pr:test/repo:100",
    nodeId: NODE_ID,
    source: "github",
    eventType: "pr_merged",
    platformUserId: "99999",
    platformLogin: "release-bot",
    artifactUrl: "https://github.com/test/repo/pull/100",
    metadata: {
      title: "release: 2026-02-20",
      baseBranch: "main",
      mergeCommitSha: "release-merge-sha",
      commitShas: promotedShas,
      repo: "test/repo",
    },
    payloadHash: "release-hash",
    producer: "github",
    producerVersion: "0.3.0",
    eventTime: new Date("2026-02-20T14:00:00Z"),
    retrievedAt: new Date("2026-02-20T14:01:00Z"),
    ingestedAt: new Date("2026-02-20T14:02:00Z"),
  };
}

// ── computeEpochWindowV1 ────────────────────────────────────────

describe("computeEpochWindowV1", () => {
  it("aligns to Monday 00:00 UTC for a 7-day epoch", () => {
    // 2026-02-22 is a Sunday
    const result = computeEpochWindowV1({
      asOfIso: "2026-02-22T06:00:00Z",
      epochLengthDays: 7,
      timezone: "UTC",
      weekStart: "monday",
    });

    expect(result.periodStartIso).toBe("2026-02-16T00:00:00.000Z");
    expect(result.periodEndIso).toBe("2026-02-23T00:00:00.000Z");
  });

  it("returns same window for any day within the same week", () => {
    const monday = computeEpochWindowV1({
      asOfIso: "2026-02-16T00:00:00Z",
      epochLengthDays: 7,
      timezone: "UTC",
      weekStart: "monday",
    });
    const wednesday = computeEpochWindowV1({
      asOfIso: "2026-02-18T12:00:00Z",
      epochLengthDays: 7,
      timezone: "UTC",
      weekStart: "monday",
    });
    const sunday = computeEpochWindowV1({
      asOfIso: "2026-02-22T23:59:59Z",
      epochLengthDays: 7,
      timezone: "UTC",
      weekStart: "monday",
    });

    expect(monday.periodStartIso).toBe(wednesday.periodStartIso);
    expect(monday.periodStartIso).toBe(sunday.periodStartIso);
    expect(monday.periodEndIso).toBe(wednesday.periodEndIso);
  });

  it("advances to next epoch on Monday boundary", () => {
    const sunday = computeEpochWindowV1({
      asOfIso: "2026-02-22T23:59:59Z",
      epochLengthDays: 7,
      timezone: "UTC",
      weekStart: "monday",
    });
    const nextMonday = computeEpochWindowV1({
      asOfIso: "2026-02-23T00:00:00Z",
      epochLengthDays: 7,
      timezone: "UTC",
      weekStart: "monday",
    });

    expect(sunday.periodEndIso).toBe(nextMonday.periodStartIso);
  });

  it("handles 14-day epoch correctly", () => {
    const result = computeEpochWindowV1({
      asOfIso: "2026-02-22T06:00:00Z",
      epochLengthDays: 14,
      timezone: "UTC",
      weekStart: "monday",
    });

    // 14-day periods from anchor (2026-01-05)
    // Period 0: Jan 5 - Jan 19, Period 1: Jan 19 - Feb 2, Period 2: Feb 2 - Feb 16, Period 3: Feb 16 - Mar 2
    expect(result.periodStartIso).toBe("2026-02-16T00:00:00.000Z");
    expect(result.periodEndIso).toBe("2026-03-02T00:00:00.000Z");
  });
});

// ── createAttributionActivities ──────────────────────────────────────

describe("createAttributionActivities", () => {
  it("returns all expected activity functions", () => {
    const activities = createAttributionActivities({
      attributionStore: makeMockStore(),
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    expect(activities.ensureEpochForWindow).toBeTypeOf("function");
    expect(activities.loadCursor).toBeTypeOf("function");
    expect(activities.collectFromSource).toBeTypeOf("function");
    expect(activities.insertReceipts).toBeTypeOf("function");
    expect(activities.saveCursor).toBeTypeOf("function");
  });
});

// ── ensureEpochForWindow ────────────────────────────────────────

describe("ensureEpochForWindow", () => {
  it("creates a new epoch when none exists", async () => {
    const epoch = makeEpoch();
    const store = makeMockStore({
      getEpochByWindow: vi.fn().mockResolvedValue(null),
      createEpoch: vi.fn().mockResolvedValue(epoch),
    });

    const { ensureEpochForWindow } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const result = await ensureEpochForWindow({
      periodStart: "2026-02-16T00:00:00.000Z",
      periodEnd: "2026-02-23T00:00:00.000Z",
      weightConfig: { "github:pr_merged": 1000 },
    });

    expect(result.isNew).toBe(true);
    expect(result.epochId).toBe("1");
    expect(result.weightConfig).toEqual({ "github:pr_merged": 1000 });
    expect(store.createEpoch).toHaveBeenCalledOnce();
  });

  it("returns existing epoch when window matches (open)", async () => {
    const epoch = makeEpoch();
    const store = makeMockStore({
      getEpochByWindow: vi.fn().mockResolvedValue(epoch),
    });

    const { ensureEpochForWindow } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const result = await ensureEpochForWindow({
      periodStart: epoch.periodStart.toISOString(),
      periodEnd: epoch.periodEnd.toISOString(),
      weightConfig: { "github:pr_merged": 1000 },
    });

    expect(result.isNew).toBe(false);
    expect(result.epochId).toBe("1");
    expect(result.weightConfig).toEqual({ "github:pr_merged": 1000 });
    expect(store.createEpoch).not.toHaveBeenCalled();
  });

  it("returns finalized epoch found by window — does not create new", async () => {
    const epoch = makeEpoch({ status: "finalized", closedAt: new Date() });
    const store = makeMockStore({
      getEpochByWindow: vi.fn().mockResolvedValue(epoch),
    });

    const { ensureEpochForWindow } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const result = await ensureEpochForWindow({
      periodStart: epoch.periodStart.toISOString(),
      periodEnd: epoch.periodEnd.toISOString(),
      weightConfig: { "github:pr_merged": 1000 },
    });

    expect(result.isNew).toBe(false);
    expect(result.status).toBe("finalized");
    expect(store.createEpoch).not.toHaveBeenCalled();
  });

  it("logs warning on weight config drift and returns pinned config", async () => {
    const epoch = makeEpoch({
      weightConfig: { "github:pr_merged": 500 },
    });
    const store = makeMockStore({
      getEpochByWindow: vi.fn().mockResolvedValue(epoch),
    });

    const logger = {
      ...mockLogger,
      warn: vi.fn(),
    } as unknown as Parameters<typeof createAttributionActivities>[0]["logger"];

    const { ensureEpochForWindow } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger,
    });

    const result = await ensureEpochForWindow({
      periodStart: epoch.periodStart.toISOString(),
      periodEnd: epoch.periodEnd.toISOString(),
      weightConfig: { "github:pr_merged": 1000 },
    });

    // Returns pinned config from existing epoch, not input
    expect(result.weightConfig).toEqual({ "github:pr_merged": 500 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedWeights: { "github:pr_merged": 500 } }),
      expect.stringContaining("Weight config drift")
    );
  });
});

// ── loadCursor ──────────────────────────────────────────────────

describe("loadCursor", () => {
  it("returns null when no cursor exists", async () => {
    const store = makeMockStore();
    const { loadCursor } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const result = await loadCursor({
      source: "github",
      stream: "pull_requests",
      sourceRef: "test/repo",
    });

    expect(result).toBeNull();
  });

  it("returns cursor value when one exists", async () => {
    const cursor: IngestionCursor = {
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      source: "github",
      stream: "pull_requests",
      sourceRef: "test/repo",
      cursorValue: "2026-02-20T00:00:00Z",
      retrievedAt: new Date(),
    };
    const store = makeMockStore({
      getCursor: vi.fn().mockResolvedValue(cursor),
    });

    const { loadCursor } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const result = await loadCursor({
      source: "github",
      stream: "pull_requests",
      sourceRef: "test/repo",
    });

    expect(result).toBe("2026-02-20T00:00:00Z");
  });
});

// ── resolveStreams ──────────────────────────────────────────────

describe("resolveStreams", () => {
  it("returns the poll adapter's streams when one is registered", async () => {
    const { resolveStreams } = createAttributionActivities({
      attributionStore: makeMockStore(),
      sourceRegistrations: new Map([["github", makeMockRegistration()]]),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    await expect(resolveStreams({ source: "github" })).resolves.toEqual({
      streams: ["pull_requests"],
    });
  });

  it("POLL_SOURCE_OPTIONAL: returns no streams (skip poll) when source is webhook-only", async () => {
    const { resolveStreams } = createAttributionActivities({
      attributionStore: makeMockStore(),
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    await expect(resolveStreams({ source: "github" })).resolves.toEqual({
      streams: [],
    });
  });
});

// ── collectFromSource ───────────────────────────────────────────

describe("collectFromSource", () => {
  it("throws when no adapter exists for source", async () => {
    const { collectFromSource } = createAttributionActivities({
      attributionStore: makeMockStore(),
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    await expect(
      collectFromSource({
        source: "discord",
        streams: ["messages"],
        cursorValue: null,
        periodStart: "2026-02-16T00:00:00Z",
        periodEnd: "2026-02-23T00:00:00Z",
      })
    ).rejects.toThrow("[SOURCE_NO_ADAPTER]");
  });

  it("calls adapter.collect() and returns events with producerVersion", async () => {
    const event = makeEvent();
    const registration = makeMockRegistration([event]);
    const registrations = new Map<string, DataSourceRegistration>([
      ["github", registration],
    ]);

    const { collectFromSource } = createAttributionActivities({
      attributionStore: makeMockStore(),
      sourceRegistrations: registrations,
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const result = await collectFromSource({
      source: "github",
      streams: ["pull_requests"],
      cursorValue: null,
      periodStart: "2026-02-16T00:00:00Z",
      periodEnd: "2026-02-23T00:00:00Z",
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("github:pr:test/repo:1");
    expect(result.producerVersion).toBe("0.3.0");
    expect(registration.poll?.collect).toHaveBeenCalledOnce();
  });
});

// ── insertReceipts ────────────────────────────────────────────

describe("insertReceipts", () => {
  it("does nothing when events array is empty", async () => {
    const store = makeMockStore();
    const { insertReceipts } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    await insertReceipts({ events: [], producerVersion: "0.3.0" });

    expect(store.insertIngestionReceipts).not.toHaveBeenCalled();
  });

  it("maps events and uses producerVersion from input", async () => {
    const store = makeMockStore();
    const { insertReceipts } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    await insertReceipts({ events: [makeEvent()], producerVersion: "0.3.0" });

    expect(store.insertIngestionReceipts).toHaveBeenCalledOnce();
    const args = vi.mocked(store.insertIngestionReceipts).mock.calls[0][0];
    expect(args[0].nodeId).toBe(NODE_ID);
    expect(args[0].source).toBe("github");
    expect(args[0].producerVersion).toBe("0.3.0");
  });
});

// ── saveCursor ──────────────────────────────────────────────────

describe("saveCursor", () => {
  it("saves cursor when no existing cursor", async () => {
    const store = makeMockStore();
    const { saveCursor } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    await saveCursor({
      source: "github",
      stream: "pull_requests",
      sourceRef: "test/repo",
      cursorValue: "2026-02-20T00:00:00Z",
    });

    expect(store.upsertCursor).toHaveBeenCalledWith(
      NODE_ID,
      SCOPE_ID,
      "github",
      "pull_requests",
      "test/repo",
      "2026-02-20T00:00:00Z"
    );
  });

  it("enforces monotonic cursor — keeps later value", async () => {
    const existingCursor: IngestionCursor = {
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      source: "github",
      stream: "pull_requests",
      sourceRef: "test/repo",
      cursorValue: "2026-02-21T00:00:00Z",
      retrievedAt: new Date(),
    };
    const store = makeMockStore({
      getCursor: vi.fn().mockResolvedValue(existingCursor),
    });

    const { saveCursor } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    // Try to save an earlier cursor — should keep the existing later one
    await saveCursor({
      source: "github",
      stream: "pull_requests",
      sourceRef: "test/repo",
      cursorValue: "2026-02-19T00:00:00Z",
    });

    expect(store.upsertCursor).toHaveBeenCalledWith(
      NODE_ID,
      SCOPE_ID,
      "github",
      "pull_requests",
      "test/repo",
      "2026-02-21T00:00:00Z" // kept existing, later value
    );
  });

  it("advances cursor when new value is later", async () => {
    const existingCursor: IngestionCursor = {
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      source: "github",
      stream: "pull_requests",
      sourceRef: "test/repo",
      cursorValue: "2026-02-19T00:00:00Z",
      retrievedAt: new Date(),
    };
    const store = makeMockStore({
      getCursor: vi.fn().mockResolvedValue(existingCursor),
    });

    const { saveCursor } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    await saveCursor({
      source: "github",
      stream: "pull_requests",
      sourceRef: "test/repo",
      cursorValue: "2026-02-21T00:00:00Z",
    });

    expect(store.upsertCursor).toHaveBeenCalledWith(
      NODE_ID,
      SCOPE_ID,
      "github",
      "pull_requests",
      "test/repo",
      "2026-02-21T00:00:00Z" // advanced to new, later value
    );
  });
});

// ── materializeSelection ────────────────────────────────────────

describe("materializeSelection", () => {
  const epoch = makeEpoch({ id: 1n });

  // Default release PR that promotes staging PRs with mergeCommitSha "abc111"
  const defaultReleasePr = makeReleasePrReceipt(["abc111"]);

  function makeDeps(storeOverrides: Partial<AttributionStore> = {}) {
    const store = makeMockStore({
      getEpoch: vi.fn().mockResolvedValue(epoch),
      getAllReceipts: vi.fn().mockResolvedValue([defaultReleasePr]),
      ...storeOverrides,
    });
    const { materializeSelection } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });
    return { store, materializeSelection };
  }

  it("returns zero counts when no unselected receipts", async () => {
    const { materializeSelection } = makeDeps({
      getSelectionCandidates: vi.fn().mockResolvedValue([]),
    });

    const result = await materializeSelection({
      epochId: "1",
      attributionPipeline: "cogni-v0.0",
    });

    expect(result).toEqual({
      totalReceipts: 0,
      newSelections: 0,
      resolved: 0,
      unresolved: 0,
    });
  });

  it("throws when epoch not found", async () => {
    const { materializeSelection } = makeDeps({
      getEpoch: vi.fn().mockResolvedValue(null),
    });

    await expect(
      materializeSelection({
        epochId: "999",
        attributionPipeline: "cogni-v0.0",
      })
    ).rejects.toThrow("epoch 999 not found");
  });

  it("creates new selection rows with resolved userId", async () => {
    const unselected = [
      makeUnselectedReceipt({ receiptId: "ev1", platformUserId: "111" }),
      makeUnselectedReceipt({ receiptId: "ev2", platformUserId: "222" }),
    ];
    const identityMap = new Map([["111", "user-aaa"]]);
    const { store, materializeSelection } = makeDeps({
      getSelectionCandidates: vi.fn().mockResolvedValue(unselected),
      resolveIdentities: vi.fn().mockResolvedValue(identityMap),
    });

    const result = await materializeSelection({
      epochId: "1",
      attributionPipeline: "cogni-v0.0",
    });

    expect(result.totalReceipts).toBe(2);
    expect(result.newSelections).toBe(2);
    expect(result.resolved).toBe(1);
    expect(result.unresolved).toBe(1);

    // Should have called insertSelectionDoNothing for each new receipt
    expect(store.insertSelectionDoNothing).toHaveBeenCalledTimes(2);

    // First call: resolved
    expect(vi.mocked(store.insertSelectionDoNothing).mock.calls[0][0]).toEqual([
      expect.objectContaining({
        nodeId: NODE_ID,
        epochId: 1n,
        receiptId: "ev1",
        userId: "user-aaa",
        included: true,
      }),
    ]);

    // Second call: unresolved (userId null)
    expect(vi.mocked(store.insertSelectionDoNothing).mock.calls[1][0]).toEqual([
      expect.objectContaining({
        receiptId: "ev2",
        userId: null,
        included: true,
      }),
    ]);

    // No updateSelectionUserId calls (all new receipts)
    expect(store.updateSelectionUserId).not.toHaveBeenCalled();
  });

  it("updates userId on existing unresolved selection rows", async () => {
    const unselected = [
      makeUnselectedReceipt({
        receiptId: "ev1",
        platformUserId: "111",
        hasExistingSelection: true,
      }),
    ];
    const identityMap = new Map([["111", "user-aaa"]]);
    const { store, materializeSelection } = makeDeps({
      getSelectionCandidates: vi.fn().mockResolvedValue(unselected),
      resolveIdentities: vi.fn().mockResolvedValue(identityMap),
    });

    const result = await materializeSelection({
      epochId: "1",
      attributionPipeline: "cogni-v0.0",
    });

    expect(result.totalReceipts).toBe(1);
    expect(result.newSelections).toBe(0);
    expect(result.resolved).toBe(1);

    // Should update, not insert
    expect(store.insertSelectionDoNothing).not.toHaveBeenCalled();
    expect(store.updateSelectionUserId).toHaveBeenCalledWith(
      1n,
      "ev1",
      "user-aaa"
    );
  });

  it("skips existing unresolved rows when identity still not found", async () => {
    const unselected = [
      makeUnselectedReceipt({
        receiptId: "ev1",
        platformUserId: "111",
        hasExistingSelection: true,
      }),
    ];
    const { store, materializeSelection } = makeDeps({
      getSelectionCandidates: vi.fn().mockResolvedValue(unselected),
      resolveIdentities: vi.fn().mockResolvedValue(new Map()),
    });

    const result = await materializeSelection({
      epochId: "1",
      attributionPipeline: "cogni-v0.0",
    });

    expect(result.totalReceipts).toBe(1);
    expect(result.newSelections).toBe(0);
    expect(result.resolved).toBe(0);
    expect(result.unresolved).toBe(1);

    // Neither insert nor update — existing row stays as-is
    expect(store.insertSelectionDoNothing).not.toHaveBeenCalled();
    expect(store.updateSelectionUserId).not.toHaveBeenCalled();
  });

  it("does NOT overwrite admin-set fields on re-run", async () => {
    // Simulate: receipt has existing selection (hasExistingSelection=true) with userId already set
    // getSelectionCandidates wouldn't return it (it filters by userId IS NULL).
    // This test verifies the contract: updateSelectionUserId is conditional.
    // The activity only calls updateSelectionUserId, which has WHERE user_id IS NULL.
    // So an admin who manually set userId to something else is never overwritten.

    // Scenario: receipt has existing unresolved selection, gets resolved
    const unselected = [
      makeUnselectedReceipt({
        receiptId: "ev1",
        platformUserId: "111",
        hasExistingSelection: true,
      }),
    ];
    const identityMap = new Map([["111", "user-aaa"]]);
    const { store, materializeSelection } = makeDeps({
      getSelectionCandidates: vi.fn().mockResolvedValue(unselected),
      resolveIdentities: vi.fn().mockResolvedValue(identityMap),
    });

    await materializeSelection({
      epochId: "1",
      attributionPipeline: "cogni-v0.0",
    });

    // updateSelectionUserId called — but the adapter's WHERE clause
    // ensures it only updates when user_id IS NULL
    expect(store.updateSelectionUserId).toHaveBeenCalledWith(
      1n,
      "ev1",
      "user-aaa"
    );
    // insertSelectionDoNothing (which overwrites all fields) is NOT called for existing rows
    expect(store.insertSelectionDoNothing).not.toHaveBeenCalled();
  });

  it("handles mixed new and existing unresolved receipts", async () => {
    const unselected = [
      makeUnselectedReceipt({
        receiptId: "ev-new",
        platformUserId: "111",
        hasExistingSelection: false,
        metadata: {
          title: "PR 1",
          baseBranch: "staging",
          mergeCommitSha: "abc111",
          repo: "test/repo",
        },
      }),
      makeUnselectedReceipt({
        receiptId: "ev-existing",
        platformUserId: "222",
        hasExistingSelection: true,
        metadata: {
          title: "PR 2",
          baseBranch: "staging",
          mergeCommitSha: "abc222",
          repo: "test/repo",
        },
      }),
    ];
    const identityMap = new Map([
      ["111", "user-aaa"],
      ["222", "user-bbb"],
    ]);
    const releasePr = makeReleasePrReceipt(["abc111", "abc222"]);
    const { store, materializeSelection } = makeDeps({
      getSelectionCandidates: vi.fn().mockResolvedValue(unselected),
      resolveIdentities: vi.fn().mockResolvedValue(identityMap),
      getAllReceipts: vi.fn().mockResolvedValue([releasePr]),
    });

    const result = await materializeSelection({
      epochId: "1",
      attributionPipeline: "cogni-v0.0",
    });

    expect(result.totalReceipts).toBe(2);
    expect(result.newSelections).toBe(1);
    expect(result.resolved).toBe(2);
    expect(result.unresolved).toBe(0);

    // New receipt → insertSelectionDoNothing
    expect(store.insertSelectionDoNothing).toHaveBeenCalledTimes(1);
    // Existing unresolved → updateSelectionUserId
    expect(store.updateSelectionUserId).toHaveBeenCalledWith(
      1n,
      "ev-existing",
      "user-bbb"
    );
  });
});

// ── findStaleOpenEpoch ──────────────────────────────────────────

describe("findStaleOpenEpoch", () => {
  it("returns null when no open epoch exists", async () => {
    const store = makeMockStore({
      getOpenEpoch: vi.fn().mockResolvedValue(null),
    });
    const { findStaleOpenEpoch } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const result = await findStaleOpenEpoch({
      periodStart: "2026-02-23T00:00:00.000Z",
      periodEnd: "2026-03-02T00:00:00.000Z",
    });

    expect(result.staleEpoch).toBeNull();
  });

  it("returns null when open epoch matches current window (not stale)", async () => {
    const epoch = makeEpoch({
      periodStart: new Date("2026-02-16T00:00:00Z"),
      periodEnd: new Date("2026-02-23T00:00:00Z"),
    });
    const store = makeMockStore({
      getOpenEpoch: vi.fn().mockResolvedValue(epoch),
    });
    const { findStaleOpenEpoch } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const result = await findStaleOpenEpoch({
      periodStart: "2026-02-16T00:00:00.000Z",
      periodEnd: "2026-02-23T00:00:00.000Z",
    });

    expect(result.staleEpoch).toBeNull();
  });

  it("returns stale epoch when open epoch is for a different window", async () => {
    const epoch = makeEpoch({
      id: 5n,
      periodStart: new Date("2026-02-16T00:00:00Z"),
      periodEnd: new Date("2026-02-23T00:00:00Z"),
      weightConfig: { "github:pr_merged": 500 },
    });
    const store = makeMockStore({
      getOpenEpoch: vi.fn().mockResolvedValue(epoch),
    });
    const { findStaleOpenEpoch } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const result = await findStaleOpenEpoch({
      periodStart: "2026-02-23T00:00:00.000Z",
      periodEnd: "2026-03-02T00:00:00.000Z",
    });

    expect(result.staleEpoch).not.toBeNull();
    expect(result.staleEpoch?.epochId).toBe("5");
    expect(result.staleEpoch?.weightConfig).toEqual({
      "github:pr_merged": 500,
    });
    expect(result.staleEpoch?.periodStart).toBe("2026-02-16T00:00:00.000Z");
    expect(result.staleEpoch?.periodEnd).toBe("2026-02-23T00:00:00.000Z");
  });
});

// ── transitionEpochForWindow ────────────────────────────────────

describe("transitionEpochForWindow", () => {
  const staleEpoch = makeEpoch({
    id: 1n,
    periodStart: new Date("2026-02-16T00:00:00Z"),
    periodEnd: new Date("2026-02-23T00:00:00Z"),
  });
  const newEpoch = makeEpoch({
    id: 2n,
    periodStart: new Date("2026-02-23T00:00:00Z"),
    periodEnd: new Date("2026-03-02T00:00:00Z"),
  });

  function makeCloseParams() {
    return {
      staleEpochId: "1",
      staleWeightConfig: { "github:pr_merged": 1000 },
      approvers: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      attributionPipeline: "cogni-v0.0",
      evaluations: [
        {
          nodeId: NODE_ID,
          epochId: "1",
          evaluationRef: "cogni.echo.v0",
          status: "locked" as const,
          algoRef: "echo-v0",
          inputsHash: "inputs-hash",
          payloadHash: "payload-hash",
          payloadJson: { totalEvents: 1, byEventType: { pr_merged: 1 } },
        },
      ],
      artifactsHash: "artifacts-hash-abc",
    };
  }

  it("closes stale epoch and creates new epoch atomically", async () => {
    const store = makeMockStore({
      lockClaimantsForEpoch: vi.fn().mockResolvedValue(3),
      transitionEpochForWindow: vi.fn().mockResolvedValue({
        epoch: newEpoch,
        isNew: true,
        closedStaleEpochId: staleEpoch.id,
      }),
    });

    const { transitionEpochForWindow } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const result = await transitionEpochForWindow({
      periodStart: "2026-02-23T00:00:00.000Z",
      periodEnd: "2026-03-02T00:00:00.000Z",
      weightConfig: { "github:pr_merged": 1000 },
      closeParams: makeCloseParams(),
    });

    expect(result.epochId).toBe("2");
    expect(result.status).toBe("open");
    expect(result.isNew).toBe(true);
    expect(result.closedStaleEpochId).toBe("1");

    // Claimants locked before transition
    expect(store.lockClaimantsForEpoch).toHaveBeenCalledWith(1n);

    // Store called with computed hashes and required closeParams
    expect(store.transitionEpochForWindow).toHaveBeenCalledOnce();
    const storeCall = vi.mocked(store.transitionEpochForWindow).mock
      .calls[0][0];
    expect(storeCall.closeParams.approverSetHash).toBeTypeOf("string");
    expect(storeCall.closeParams.weightConfigHash).toBeTypeOf("string");
    expect(storeCall.closeParams.allocationAlgoRef).toBe("weight-sum-v0");
    expect(storeCall.closeParams.evaluations).toHaveLength(1);
    expect(storeCall.closeParams.evaluations[0].epochId).toBe(1n);
  });

  it("returns existing epoch on idempotent rerun", async () => {
    const existingEpoch = makeEpoch({
      id: 2n,
      periodStart: new Date("2026-02-23T00:00:00Z"),
      periodEnd: new Date("2026-03-02T00:00:00Z"),
    });
    const store = makeMockStore({
      lockClaimantsForEpoch: vi.fn().mockResolvedValue(0),
      transitionEpochForWindow: vi.fn().mockResolvedValue({
        epoch: existingEpoch,
        isNew: false,
        closedStaleEpochId: 1n,
      }),
    });

    const { transitionEpochForWindow } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const result = await transitionEpochForWindow({
      periodStart: "2026-02-23T00:00:00.000Z",
      periodEnd: "2026-03-02T00:00:00.000Z",
      weightConfig: { "github:pr_merged": 1000 },
      closeParams: makeCloseParams(),
    });

    expect(result.epochId).toBe("2");
    expect(result.isNew).toBe(false);
    expect(result.closedStaleEpochId).toBe("1");
  });

  it("works with empty approvers array", async () => {
    const store = makeMockStore({
      lockClaimantsForEpoch: vi.fn().mockResolvedValue(0),
      transitionEpochForWindow: vi.fn().mockResolvedValue({
        epoch: newEpoch,
        isNew: true,
        closedStaleEpochId: 1n,
      }),
    });

    const { transitionEpochForWindow } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const closeParams = makeCloseParams();
    closeParams.approvers = [];

    const result = await transitionEpochForWindow({
      periodStart: "2026-02-23T00:00:00.000Z",
      periodEnd: "2026-03-02T00:00:00.000Z",
      weightConfig: { "github:pr_merged": 1000 },
      closeParams,
    });

    expect(result.epochId).toBe("2");
    // Empty approvers → computeApproverSetHash([]) still produces a valid hash
    const storeCall = vi.mocked(store.transitionEpochForWindow).mock
      .calls[0][0];
    expect(storeCall.closeParams.approverSetHash).toBeTypeOf("string");
    expect(storeCall.closeParams.approvers).toEqual([]);
  });

  it("locks claimants before calling store transition", async () => {
    const callOrder: string[] = [];
    const store = makeMockStore({
      lockClaimantsForEpoch: vi.fn().mockImplementation(async () => {
        callOrder.push("lockClaimants");
        return 2;
      }),
      transitionEpochForWindow: vi.fn().mockImplementation(async () => {
        callOrder.push("transition");
        return {
          epoch: newEpoch,
          isNew: true,
          closedStaleEpochId: 1n,
        };
      }),
    });

    const { transitionEpochForWindow } = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    await transitionEpochForWindow({
      periodStart: "2026-02-23T00:00:00.000Z",
      periodEnd: "2026-03-02T00:00:00.000Z",
      weightConfig: { "github:pr_merged": 1000 },
      closeParams: makeCloseParams(),
    });

    expect(callOrder).toEqual(["lockClaimants", "transition"]);
  });
});

// ── computeAllocations ──────────────────────────────────────────

describe("computeAllocations", () => {
  it("dispatches through the profile allocator and writes user projections", async () => {
    const store = makeMockStore({
      getSelectedReceiptsForAllocation: vi.fn().mockResolvedValue([
        {
          receiptId: "receipt-1",
          userId: "user-1",
          source: "github",
          eventType: "pr_merged",
          included: true,
          weightOverrideMilli: null,
        },
        {
          receiptId: "receipt-2",
          userId: "user-2",
          source: "github",
          eventType: "pr_merged",
          included: true,
          weightOverrideMilli: null,
        },
      ]),
      getEvaluationsForEpoch: vi
        .fn()
        .mockResolvedValue([makeEvaluation({ status: "draft" })]),
      getUserProjectionsForEpoch: vi.fn().mockResolvedValue([]),
    });

    const activities = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const result = await activities.computeAllocations({
      epochId: "1",
      attributionPipeline: "cogni-v0.0",
      weightConfig: { "github:pr_merged": 1000 },
    });

    expect(result).toEqual({
      totalAllocations: 2,
      totalProposedUnits: "2000",
    });
    expect(store.upsertUserProjections).toHaveBeenCalledOnce();
    expect(store.deleteStaleUserProjections).toHaveBeenCalledWith(1n, [
      "user-1",
      "user-2",
    ]);
  });

  it("fails when the allocator's required evaluations are missing", async () => {
    const store = makeMockStore({
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
      getEvaluationsForEpoch: vi.fn().mockResolvedValue([]),
    });

    const activities = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    await expect(
      activities.computeAllocations({
        epochId: "1",
        attributionPipeline: "cogni-v0.0",
        weightConfig: { "github:pr_merged": 1000 },
      })
    ).rejects.toThrow(/requires evaluations \[cogni\.echo\.v0\]/);
  });
});

describe("finalizeEpoch", () => {
  it("finalizes using claimant allocations and preserves unresolved identities", async () => {
    vi.mocked(verifyTypedData).mockResolvedValue(true);

    const signer = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const reviewEpoch = makeEpoch({
      status: "review",
      allocationAlgoRef: "weight-sum-v0",
      weightConfigHash: "weight-hash",
      approvers: [signer],
      approverSetHash: await computeApproverSetHash([signer]),
    });

    const finalizeEpochAtomic = vi.fn().mockImplementation(async (params) => ({
      epoch: {
        ...reviewEpoch,
        status: "finalized",
        poolTotalCredits: params.poolTotal,
        closedAt: new Date(),
      },
      statement: {
        id: "stmt-1",
        nodeId: NODE_ID,
        epochId: reviewEpoch.id,
        finalAllocationSetHash: params.statement.finalAllocationSetHash,
        poolTotalCredits: params.statement.poolTotalCredits,
        statementLines: params.statement.statementLines,
        supersedesStatementId: null,
        createdAt: new Date(),
      },
    }));

    const store = makeMockStore({
      getEpoch: vi.fn().mockResolvedValue(reviewEpoch),
      loadLockedClaimants: vi.fn().mockResolvedValue([
        {
          id: "claimant-1",
          nodeId: NODE_ID,
          epochId: reviewEpoch.id,
          receiptId: "receipt-1",
          status: "locked" as const,
          resolverRef: "cogni.default-author.v0",
          algoRef: "default-author-v0",
          inputsHash: "inputs-hash-1",
          claimantKeys: ["user:user-1"],
          createdAt: new Date(),
          createdBy: "system",
        },
        {
          id: "claimant-2",
          nodeId: NODE_ID,
          epochId: reviewEpoch.id,
          receiptId: "receipt-2",
          status: "locked" as const,
          resolverRef: "cogni.default-author.v0",
          algoRef: "default-author-v0",
          inputsHash: "inputs-hash-2",
          claimantKeys: ["identity:github:42"],
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
        {
          receiptId: "receipt-2",
          userId: "user-1",
          source: "github",
          eventType: "pr_merged",
          included: true,
          weightOverrideMilli: null,
        },
      ]),
      getEvaluationsForEpoch: vi.fn().mockResolvedValue([
        makeEvaluation({
          status: "locked",
          epochId: reviewEpoch.id,
          payloadJson: {
            totalEvents: 2,
            byEventType: { pr_merged: 2 },
            byUserId: { "user-1": 2 },
          },
        }),
      ]),
      getPoolComponentsForEpoch: vi.fn().mockResolvedValue([
        {
          id: "pool-1",
          nodeId: NODE_ID,
          epochId: reviewEpoch.id,
          componentId: "base_issuance",
          algorithmVersion: "v1",
          inputsJson: { base_amount: 10000 },
          amountCredits: 10000n,
          evidenceRef: null,
          computedAt: new Date(),
        },
      ]),
      finalizeEpochAtomic,
    });

    const activities = createAttributionActivities({
      attributionStore: store,
      sourceRegistrations: new Map(),
      registries,
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const result = await activities.finalizeEpoch({
      epochId: reviewEpoch.id.toString(),
      signature: "0xdeadbeef",
      signerAddress: signer,
    });

    expect(result.statementLineCount).toBe(2);
    expect(finalizeEpochAtomic).toHaveBeenCalledTimes(1);

    const finalizeParams = finalizeEpochAtomic.mock.calls[0]?.[0];
    // Both receipts have equal weight (same eventType, no override), each claimant owns one receipt
    expect(finalizeParams.statement.statementLines).toEqual([
      expect.objectContaining({
        claimant_key: "identity:github:42",
        final_units: expect.any(String),
      }),
      expect.objectContaining({
        claimant_key: "user:user-1",
        final_units: expect.any(String),
      }),
    ]);
  });
});
