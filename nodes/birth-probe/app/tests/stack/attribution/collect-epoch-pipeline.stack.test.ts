// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/attribution/collect-epoch-pipeline.stack`
 * Purpose: End-to-end Temporal stack test for CollectEpochWorkflow exercising the full workflow→activity serialization boundary with a fake GitHub adapter.
 * Scope: Starts a dedicated Temporal Worker with real DB activities + fake DataSourceRegistration, verifying receipts, selections, evaluations, and identity resolution. Does not test webhook ingestion, schedule triggers, or multi-source pipelines.
 * Invariants:
 *   - TEMPORAL_SERIALIZATION_BOUNDARY: All activity inputs cross JSON wire format (Date→string, bigint→string)
 *   - SELECTION_POLICY_DELEGATED: Selection runs via plugin dispatch, not hardcoded logic
 *   - ACTIVITY_IDEMPOTENT: Re-running the workflow produces the same DB state
 * Side-effects: IO (Temporal gRPC, PostgreSQL)
 * Links: packages/temporal-workflows/src/workflows/collect-epoch.workflow.ts
 * @internal
 */

import { randomUUID } from "node:crypto";
import { createDefaultRegistries } from "@cogni/attribution-pipeline-plugins";
import { DrizzleAttributionAdapter } from "@cogni/db-client";
import type { DataSourceRegistration } from "@cogni/ingestion-core";
import { Client, Connection } from "@temporalio/client";
import {
  bundleWorkflowCode,
  NativeConnection,
  Worker,
} from "@temporalio/worker";
import {
  createFakeGitHubRegistration,
  makeCannedGitHubEvents,
} from "@tests/_fixtures/attribution/fake-github-registration";
import {
  seedUserBinding,
  TEST_NODE_ID,
} from "@tests/_fixtures/attribution/seed-attribution";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEnrichmentActivities } from "../../../../../services/scheduler-worker/src/activities/enrichment";
import { createAttributionActivities } from "../../../../../services/scheduler-worker/src/activities/ledger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dedicated scope ID for this test — avoids epoch/receipt collisions with other tests */
const PIPELINE_TEST_SCOPE_ID = "00000000-0000-4000-8000-0000000000bb";

/** Unique task queue per test run — prevents interference with dev:stack worker */
const TEST_TASK_QUEUE = `ledger-test-${randomUUID().slice(0, 8)}`;

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "cogni-test";

const TEST_PIPELINE = "cogni-v0.0";

/** Epoch window: a Monday-aligned week in a test-safe range (far from other fixtures) */
const PERIOD_START = new Date("2026-06-01T00:00:00Z"); // Monday
const PERIOD_END = new Date("2026-06-08T00:00:00Z"); // Following Monday
const EPOCH_MIDPOINT = new Date("2026-06-04T12:00:00Z"); // Thursday noon

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: console.error,
  debug: () => {},
  child: function () {
    return this;
  },
} as unknown as Parameters<typeof createAttributionActivities>[0]["logger"];

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let workerConnection: NativeConnection;
let clientConnection: Connection;
let client: Client;
let worker: Worker;
let workerRunPromise: Promise<void>;

const cannedEvents = makeCannedGitHubEvents(EPOCH_MIDPOINT);

describe("[attribution] CollectEpochWorkflow pipeline (stack)", () => {
  beforeAll(async () => {
    // 1. Build fake source registration
    const fakeRegistration = createFakeGitHubRegistration(cannedEvents);
    const sourceRegistrations = new Map<string, DataSourceRegistration>([
      ["github", fakeRegistration],
    ]);

    // 2. Build real DB store with dedicated scope
    const db = getSeedDb();
    const attributionStore = new DrizzleAttributionAdapter(
      db,
      PIPELINE_TEST_SCOPE_ID
    );
    const registries = createDefaultRegistries();

    // 3. Create activities with real DB + fake adapter
    const ledgerActivities = createAttributionActivities({
      attributionStore,
      sourceRegistrations,
      registries,
      nodeId: TEST_NODE_ID,
      scopeId: PIPELINE_TEST_SCOPE_ID,
      chainId: 8453,
      logger: mockLogger,
    });

    const enrichmentActivities = createEnrichmentActivities({
      attributionStore,
      nodeId: TEST_NODE_ID,
      logger: mockLogger,
      registries,
    });

    const activities = { ...ledgerActivities, ...enrichmentActivities };

    // 4. Bundle workflow code (compiles TS → deterministic JS bundle)
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: new URL(
        "../../../../../packages/temporal-workflows/src/ledger.ts",
        import.meta.url
      ).pathname,
    });

    // 5. Start Temporal worker on isolated task queue
    workerConnection = await NativeConnection.connect({
      address: TEMPORAL_ADDRESS,
    });
    worker = await Worker.create({
      connection: workerConnection,
      namespace: TEMPORAL_NAMESPACE,
      taskQueue: TEST_TASK_QUEUE,
      workflowBundle,
      activities,
    });

    workerRunPromise = worker.run();

    // 6. Create Temporal client for starting workflows
    clientConnection = await Connection.connect({ address: TEMPORAL_ADDRESS });
    client = new Client({
      connection: clientConnection,
      namespace: TEMPORAL_NAMESPACE,
    });
  }, 60_000); // bundleWorkflowCode can take ~30s

  afterAll(async () => {
    worker?.shutdown();
    await workerRunPromise?.catch(() => {}); // swallow shutdown error
    await workerConnection?.close();
    await clientConnection?.close();
    // No DB cleanup needed — reset-db globalSetup handles it, and we use a dedicated scope ID
  }, 30_000);

  it("runs full pipeline: collect → insert → select → evaluate → allocate", async () => {
    // Start the workflow with TemporalScheduledStartTime set (normally injected by Temporal Schedule)
    const workflowId = `test-collect-pipeline-${randomUUID().slice(0, 8)}`;

    const handle = await client.workflow.start("CollectEpochWorkflow", {
      workflowId,
      taskQueue: TEST_TASK_QUEUE,
      args: [
        {
          input: {
            version: 1,
            scopeId: PIPELINE_TEST_SCOPE_ID,
            scopeKey: "test-pipeline",
            epochLengthDays: 7,
            activitySources: {
              github: {
                attributionPipeline: TEST_PIPELINE,
                sourceRefs: ["test-org/test-repo"],
              },
            },
            // Omit baseIssuanceCredits and approvers — skip pool/auto-close paths
          },
        },
      ],
      searchAttributes: {
        // The workflow reads this to compute the epoch window
        TemporalScheduledStartTime: [EPOCH_MIDPOINT],
      },
    });

    // Wait for workflow completion (throws on workflow failure)
    await handle.result();

    // ── Assert DB state ──────────────────────────────────────────

    const store = new DrizzleAttributionAdapter(
      getSeedDb(),
      PIPELINE_TEST_SCOPE_ID
    );

    // 1. Epoch was created
    const epoch = await store.getEpochByWindow(
      TEST_NODE_ID,
      PIPELINE_TEST_SCOPE_ID,
      PERIOD_START,
      PERIOD_END
    );
    if (!epoch) throw new Error("Epoch not found after workflow completion");
    expect(epoch.status).toBe("open");

    // 2. Receipts were inserted (proves Date serialization works across Temporal boundary)
    const receipts = await store.getReceiptsForWindow(
      TEST_NODE_ID,
      PERIOD_START,
      PERIOD_END
    );
    expect(receipts).toHaveLength(cannedEvents.length);

    // Verify receipt fields survived serialization (check a staging PR, not the release PR)
    const stagingPr = receipts.find((r) => r.receiptId === cannedEvents[1].id);
    if (!stagingPr) throw new Error("Expected staging PR receipt not found");
    expect(stagingPr.source).toBe("github");
    expect(stagingPr.eventType).toBe("pr_merged");
    expect(stagingPr.platformUserId).toBe("12345");
    expect(stagingPr.eventTime).toBeInstanceOf(Date);

    // 3. Selections were materialized
    // getSelectionCandidates returns receipts with NO selection row OR userId IS NULL.
    // Since we have no user_bindings in the test DB, userId will be null — but selection
    // rows MUST exist (hasExistingSelection: true). This proves the selection policy ran.
    const unselected = await store.getSelectionCandidates(
      TEST_NODE_ID,
      epoch.id
    );
    for (const u of unselected) {
      expect(u.hasExistingSelection).toBe(true);
    }

    // 4. Evaluations were created (echo enricher writes draft evaluations)
    const evaluation = await store.getEvaluation(
      epoch.id,
      "cogni.echo.v0",
      "draft"
    );
    expect(evaluation).toBeDefined();

    // 5. User projections were computed
    // Projections may be empty if no identity resolution matched (platformUserId → userId),
    // but the pipeline must complete without error regardless.
    await store.getUserProjectionsForEpoch(epoch.id);
  }, 30_000);

  it("is idempotent — second run produces same state", async () => {
    const workflowId = `test-collect-idempotent-${randomUUID().slice(0, 8)}`;

    const handle = await client.workflow.start("CollectEpochWorkflow", {
      workflowId,
      taskQueue: TEST_TASK_QUEUE,
      args: [
        {
          input: {
            version: 1,
            scopeId: PIPELINE_TEST_SCOPE_ID,
            scopeKey: "test-pipeline",
            epochLengthDays: 7,
            activitySources: {
              github: {
                attributionPipeline: TEST_PIPELINE,
                sourceRefs: ["test-org/test-repo"],
              },
            },
          },
        },
      ],
      searchAttributes: {
        TemporalScheduledStartTime: [EPOCH_MIDPOINT],
      },
    });

    // Should complete without error — epoch already exists, receipts deduplicated via PK
    await handle.result();

    // Verify receipt count unchanged (no duplicates created)
    const store = new DrizzleAttributionAdapter(
      getSeedDb(),
      PIPELINE_TEST_SCOPE_ID
    );
    const receipts = await store.getReceiptsForWindow(
      TEST_NODE_ID,
      PERIOD_START,
      PERIOD_END
    );
    expect(receipts).toHaveLength(cannedEvents.length);
  }, 30_000);

  it("resolves identities when user_bindings exist", async () => {
    // Seed user_bindings for the canned events' platformUserIds.
    // materializeSelection will find selections with null userId (from prior runs),
    // resolve identities via user_bindings, and call updateSelectionUserId.
    const db = getSeedDb();
    const userAliceId = await seedUserBinding(db, {
      externalId: "12345",
      providerLogin: "alice",
    });
    const userBobId = await seedUserBinding(db, {
      externalId: "67890",
      providerLogin: "bob",
    });

    const workflowId = `test-collect-identity-${randomUUID().slice(0, 8)}`;

    const handle = await client.workflow.start("CollectEpochWorkflow", {
      workflowId,
      taskQueue: TEST_TASK_QUEUE,
      args: [
        {
          input: {
            version: 1,
            scopeId: PIPELINE_TEST_SCOPE_ID,
            scopeKey: "test-pipeline",
            epochLengthDays: 7,
            activitySources: {
              github: {
                attributionPipeline: TEST_PIPELINE,
                sourceRefs: ["test-org/test-repo"],
              },
            },
          },
        },
      ],
      searchAttributes: {
        TemporalScheduledStartTime: [EPOCH_MIDPOINT],
      },
    });

    await handle.result();

    // Verify selections now have resolved userIds
    const store = new DrizzleAttributionAdapter(
      getSeedDb(),
      PIPELINE_TEST_SCOPE_ID
    );
    const epoch = await store.getEpochByWindow(
      TEST_NODE_ID,
      PIPELINE_TEST_SCOPE_ID,
      PERIOD_START,
      PERIOD_END
    );
    if (!epoch) throw new Error("Epoch not found after workflow completion");

    // All receipts should now have resolved userIds — no unselected with null userId
    const unselected = await store.getSelectionCandidates(
      TEST_NODE_ID,
      epoch.id
    );
    // Only the release PR (platformUserId "99999") has no binding — it's excluded anyway
    for (const u of unselected) {
      expect(u.receipt.platformUserId).toBe("99999");
    }

    // User projections should exist for both resolved users
    const projections = await store.getUserProjectionsForEpoch(epoch.id);
    expect(projections.length).toBeGreaterThanOrEqual(2);

    const projectedUserIds = new Set(projections.map((p) => p.userId));
    expect(projectedUserIds.has(userAliceId)).toBe(true);
    expect(projectedUserIds.has(userBobId)).toBe(true);
  }, 30_000);
});
