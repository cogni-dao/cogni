// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fixtures/attribution/seed-attribution`
 * Purpose: Reusable ledger test fixtures for seeding epochs, ingestion receipts, user bindings, and related data.
 * Scope: Factory functions for ledger test data + composite seeders for common test scenarios. Does not contain test logic or assertions.
 * Invariants: All generated IDs are deterministic from inputs where possible.
 * Side-effects: none (pure data factories); composite seeders and identity seeders perform IO via store/db
 * Links: packages/attribution-ledger/src/store.ts, tests/component/db/drizzle-attribution.adapter.int.test.ts
 * @internal
 */

import { randomUUID } from "node:crypto";

import type {
  AttributionEpoch,
  AttributionPoolComponent,
  AttributionStatement,
  AttributionStore,
  InsertPoolComponentParams,
  InsertReceiptParams,
  InsertSelectionAutoParams,
  InsertStatementParams,
  InsertUserProjectionParams,
  UpsertEvaluationParams,
  UpsertSelectionParams,
} from "@cogni/attribution-ledger";
import type { Database } from "@cogni/db-client";
import { userBindings, users } from "@cogni/db-schema";

/** Stable test node ID for ledger integration tests */
export const TEST_NODE_ID = "00000000-0000-4000-8000-000000000001";

/** Stable test scope ID for ledger integration tests */
export const TEST_SCOPE_ID = "00000000-0000-4000-8000-000000000002";

/** Scope ID guaranteed to differ from TEST_SCOPE_ID, for cross-scope isolation tests */
export const OTHER_SCOPE_ID = "00000000-0000-4000-8000-000000000099";

/** Third scope ID for promotion selection tests — avoids epoch collisions with OTHER_SCOPE_ID */
export const PROMO_SCOPE_ID = "00000000-0000-4000-8000-0000000000aa";

/** Non-overlapping epoch window for test isolation. Default length = 7 days (V0 default). */
export function epochWindow(
  offset = 0,
  lengthDays = 7
): {
  periodStart: Date;
  periodEnd: Date;
} {
  const base = new Date("2026-01-05T00:00:00Z"); // Monday-aligned anchor
  const start = new Date(base);
  start.setDate(start.getDate() + offset * lengthDays);
  const end = new Date(start);
  end.setDate(end.getDate() + lengthDays);
  return { periodStart: start, periodEnd: end };
}

/** Default weight config for tests */
export const TEST_WEIGHT_CONFIG: Record<string, number> = {
  "github:pr_merged": 8000,
  "github:review_submitted": 2000,
  "discord:message_sent": 500,
};

/** Stable pinned approvers for review/finalized epoch fixtures */
const TEST_PINNED_APPROVERS = [`0x${"a1".repeat(20)}`, `0x${"b2".repeat(20)}`];

/** Build an ingestion receipt insert param with sensible defaults */
export function makeIngestionReceipt(
  overrides: Partial<InsertReceiptParams> & { receiptId: string }
): InsertReceiptParams {
  return {
    nodeId: TEST_NODE_ID,
    source: "github",
    eventType: "pr_merged",
    platformUserId: "12345",
    payloadHash: "test-hash-placeholder",
    producer: "test-adapter",
    producerVersion: "0.0.0-test",
    eventTime: new Date("2026-01-06T12:00:00Z"),
    retrievedAt: new Date("2026-01-06T12:00:01Z"),
    ...overrides,
  };
}

/** Build a selection upsert param with sensible defaults */
export function makeSelection(
  overrides: Partial<UpsertSelectionParams> & {
    epochId: bigint;
    receiptId: string;
  }
): UpsertSelectionParams {
  return {
    nodeId: TEST_NODE_ID,
    included: true,
    ...overrides,
  };
}

/** Build a selection auto-populate param (narrowed insert) */
export function makeSelectionAuto(
  overrides: Partial<InsertSelectionAutoParams> & {
    epochId: bigint;
    receiptId: string;
  }
): InsertSelectionAutoParams {
  return {
    nodeId: TEST_NODE_ID,
    userId: null,
    included: true,
    ...overrides,
  };
}

/** Build a user projection insert param with sensible defaults */
export function makeUserProjection(
  overrides: Partial<InsertUserProjectionParams> & {
    epochId: bigint;
    userId: string;
  }
): InsertUserProjectionParams {
  return {
    nodeId: TEST_NODE_ID,
    projectedUnits: 1000n,
    receiptCount: 1,
    ...overrides,
  };
}

/** Build a pool component insert param with sensible defaults */
export function makePoolComponent(
  overrides: Partial<InsertPoolComponentParams> & { epochId: bigint }
): InsertPoolComponentParams {
  return {
    nodeId: TEST_NODE_ID,
    componentId: "base_issuance",
    algorithmVersion: "v1.0.0",
    inputsJson: { base_amount: 10000 },
    amountCredits: 10000n,
    ...overrides,
  };
}

/** Build an epoch statement insert param with sensible defaults */
export function makeEpochStatement(
  overrides: Partial<InsertStatementParams> & { epochId: bigint }
): InsertStatementParams {
  return {
    nodeId: TEST_NODE_ID,
    finalAllocationSetHash: "test-hash-abc123",
    poolTotalCredits: 10000n,
    statementLines: [
      {
        claimant_key: "user:user-1",
        claimant: { kind: "user", userId: "user-1" },
        final_units: "8000",
        pool_share: "0.800000",
        credit_amount: "8000",
        receipt_ids: ["test-receipt-1"],
      },
      {
        claimant_key: "user:user-2",
        claimant: { kind: "user", userId: "user-2" },
        final_units: "2000",
        pool_share: "0.200000",
        credit_amount: "2000",
        receipt_ids: ["test-receipt-2"],
      },
    ],
    ...overrides,
  };
}

/** Build an evaluation upsert param with sensible defaults */
export function makeEvaluation(
  overrides: Partial<UpsertEvaluationParams> & { epochId: bigint }
): UpsertEvaluationParams {
  return {
    nodeId: TEST_NODE_ID,
    evaluationRef: "cogni.echo.v0",
    status: "draft",
    algoRef: "echo-enricher-v0",
    inputsHash: "a".repeat(64),
    payloadHash: "b".repeat(64),
    payloadJson: { test: true },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Identity seeding — users + bindings for identity resolution tests
// ---------------------------------------------------------------------------

/**
 * Seeds a user row and a GitHub user_binding in one call.
 * Idempotent via onConflictDoNothing on both tables.
 *
 * @returns The userId used (generated if not provided)
 */
export async function seedUserBinding(
  db: Database,
  params: {
    userId?: string;
    provider?: string;
    externalId: string;
    providerLogin?: string;
  }
): Promise<string> {
  const userId = params.userId ?? randomUUID();
  await db
    .insert(users)
    .values({ id: userId, name: `Test User ${params.externalId}` })
    .onConflictDoNothing({ target: users.id });
  await db
    .insert(userBindings)
    .values({
      id: randomUUID(),
      userId,
      provider: params.provider ?? "github",
      externalId: params.externalId,
      providerLogin: params.providerLogin,
    })
    .onConflictDoNothing();
  return userId;
}

// ---------------------------------------------------------------------------
// Composite seeders — seed a full scenario in one call
// ---------------------------------------------------------------------------

/** Result of seeding a closed epoch with all related data */
export interface SeededClosedEpoch {
  epoch: AttributionEpoch;
  poolComponent: AttributionPoolComponent;
  statement: AttributionStatement;
}

/**
 * Seeds a complete closed epoch with receipts, selections, user projections,
 * a pool component, and a statement. Suitable for testing read routes.
 *
 * @param store - The AttributionStore to seed into
 * @param opts.nodeId - Node ID (defaults to TEST_NODE_ID)
 * @param opts.scopeId - Scope ID (defaults to TEST_SCOPE_ID)
 * @param opts.epochOffset - Epoch window offset for test isolation (defaults to 0)
 */
export async function seedClosedEpoch(
  store: AttributionStore,
  opts: {
    nodeId?: string;
    scopeId?: string;
    epochOffset?: number;
  } = {}
): Promise<SeededClosedEpoch> {
  const nodeId = opts.nodeId ?? TEST_NODE_ID;
  const scopeId = opts.scopeId ?? TEST_SCOPE_ID;
  const { periodStart, periodEnd } = epochWindow(opts.epochOffset ?? 0);

  // 1. Create epoch
  const epoch = await store.createEpoch({
    nodeId,
    scopeId,
    periodStart,
    periodEnd,
    weightConfig: TEST_WEIGHT_CONFIG,
  });

  // 2. Insert ingestion receipts within the epoch window
  const eventMidpoint = new Date(
    (periodStart.getTime() + periodEnd.getTime()) / 2
  );
  await store.insertIngestionReceipts([
    makeIngestionReceipt({
      receiptId: `test-receipt-${epoch.id}-1`,
      nodeId,
      platformUserId: "gh-user-101",
      platformLogin: "alice",
      artifactUrl: "https://github.com/test/repo/pull/1",
      eventTime: eventMidpoint,
      retrievedAt: eventMidpoint,
    }),
    makeIngestionReceipt({
      receiptId: `test-receipt-${epoch.id}-2`,
      nodeId,
      source: "github",
      eventType: "review_submitted",
      platformUserId: "gh-user-202",
      platformLogin: "bob",
      artifactUrl: "https://github.com/test/repo/pull/1#review",
      eventTime: eventMidpoint,
      retrievedAt: eventMidpoint,
    }),
  ]);

  // 3. Insert selections (auto-populate pattern)
  await store.insertSelectionDoNothing([
    makeSelectionAuto({
      nodeId,
      epochId: epoch.id,
      receiptId: `test-receipt-${epoch.id}-1`,
      userId: "user-1",
      included: true,
    }),
    makeSelectionAuto({
      nodeId,
      epochId: epoch.id,
      receiptId: `test-receipt-${epoch.id}-2`,
      userId: "user-2",
      included: true,
    }),
  ]);

  // 4. Insert user projections
  await store.insertUserProjections([
    makeUserProjection({
      nodeId,
      epochId: epoch.id,
      userId: "user-1",
      projectedUnits: 8000n,
      receiptCount: 1,
    }),
    makeUserProjection({
      nodeId,
      epochId: epoch.id,
      userId: "user-2",
      projectedUnits: 2000n,
      receiptCount: 1,
    }),
  ]);

  // 5. Insert pool component
  const { component: poolComponent } = await store.insertPoolComponent(
    makePoolComponent({
      nodeId,
      epochId: epoch.id,
    })
  );

  // 6. Transition epoch: open → review → finalized
  const poolTotal = 10000n;
  await store.closeIngestion(
    epoch.id,
    TEST_PINNED_APPROVERS,
    "test-approver-set-hash",
    "weight-sum-v0",
    "test-weight-config-hash"
  );
  const finalizedEpoch = await store.finalizeEpoch(epoch.id, poolTotal);

  // 7. Insert epoch statement (after finalize)
  const statement = await store.insertEpochStatement(
    makeEpochStatement({
      nodeId,
      epochId: epoch.id,
    })
  );

  return { epoch: finalizedEpoch, poolComponent, statement };
}

/** Result of seeding an epoch in review status (not yet finalized) */
export interface SeededReviewEpoch {
  epoch: AttributionEpoch;
  poolComponent: AttributionPoolComponent;
  receiptIds: string[];
}

/**
 * Seeds a complete epoch in review status with receipts, selections, user projections,
 * and a pool component. Suitable for testing sign-data and subject-override routes.
 */
export async function seedReviewEpoch(
  store: AttributionStore,
  opts: {
    nodeId?: string;
    scopeId?: string;
    epochOffset?: number;
  } = {}
): Promise<SeededReviewEpoch> {
  const nodeId = opts.nodeId ?? TEST_NODE_ID;
  const scopeId = opts.scopeId ?? TEST_SCOPE_ID;
  const { periodStart, periodEnd } = epochWindow(opts.epochOffset ?? 0);

  const epoch = await store.createEpoch({
    nodeId,
    scopeId,
    periodStart,
    periodEnd,
    weightConfig: TEST_WEIGHT_CONFIG,
  });

  const eventMidpoint = new Date(
    (periodStart.getTime() + periodEnd.getTime()) / 2
  );
  const receiptIds = [
    `test-receipt-${epoch.id}-1`,
    `test-receipt-${epoch.id}-2`,
  ];

  await store.insertIngestionReceipts([
    makeIngestionReceipt({
      receiptId: receiptIds[0],
      nodeId,
      platformUserId: "gh-user-101",
      platformLogin: "alice",
      artifactUrl: "https://github.com/test/repo/pull/1",
      eventTime: eventMidpoint,
      retrievedAt: eventMidpoint,
    }),
    makeIngestionReceipt({
      receiptId: receiptIds[1],
      nodeId,
      source: "github",
      eventType: "review_submitted",
      platformUserId: "gh-user-202",
      platformLogin: "bob",
      artifactUrl: "https://github.com/test/repo/pull/1#review",
      eventTime: eventMidpoint,
      retrievedAt: eventMidpoint,
    }),
  ]);

  await store.insertSelectionDoNothing([
    makeSelectionAuto({
      nodeId,
      epochId: epoch.id,
      receiptId: receiptIds[0],
      userId: "user-1",
      included: true,
    }),
    makeSelectionAuto({
      nodeId,
      epochId: epoch.id,
      receiptId: receiptIds[1],
      userId: "user-2",
      included: true,
    }),
  ]);

  await store.insertUserProjections([
    makeUserProjection({
      nodeId,
      epochId: epoch.id,
      userId: "user-1",
      projectedUnits: 8000n,
      receiptCount: 1,
    }),
    makeUserProjection({
      nodeId,
      epochId: epoch.id,
      userId: "user-2",
      projectedUnits: 2000n,
      receiptCount: 1,
    }),
  ]);

  const { component: poolComponent } = await store.insertPoolComponent(
    makePoolComponent({
      nodeId,
      epochId: epoch.id,
    })
  );

  // Transition open → review (stop here — do NOT finalize)
  const reviewEpoch = await store.closeIngestion(
    epoch.id,
    TEST_PINNED_APPROVERS,
    "test-approver-set-hash",
    "weight-sum-v0",
    "test-weight-config-hash"
  );

  return { epoch: reviewEpoch, poolComponent, receiptIds };
}
