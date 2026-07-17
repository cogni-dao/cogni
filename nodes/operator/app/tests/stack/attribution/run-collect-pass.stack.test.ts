// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/attribution/run-collect-pass.stack`
 * Purpose: Prove the in-process collect pass (runCollectPass) fills an epoch + selection over
 *   PRE-DELIVERED (webhook-style) receipts WITHOUT any poll adapter — the collect dispatch-hop a
 *   spawned node runs against its OWN ledger DB.
 * Scope: Real testcontainer Postgres + DrizzleAttributionAdapter + a webhook-only source
 *   registration (empty Map → no poll). Receipts are inserted directly, standing in for the
 *   Phase-1 receipt seam. Does not use Temporal, does not test the operator's CollectEpochWorkflow.
 * Invariants:
 *   - WEBHOOK_ONLY_SKIPS_POLL: no poll adapter registered → pass proceeds to select over delivered receipts.
 *   - SELECTION_POLICY_DELEGATED: selection rows materialize via plugin dispatch.
 * Side-effects: IO (PostgreSQL)
 * Links: packages/attribution-collect/src/run-collect-pass.ts, docs/design/attribution-operator-gateway.md
 * @internal
 */

import { runCollectPass } from "@cogni/attribution-collect";
import { createValidatedAttributionStore } from "@cogni/attribution-ledger";
import { createDefaultRegistries } from "@cogni/attribution-pipeline-plugins";
import { DrizzleAttributionAdapter } from "@cogni/db-client";
import type { DataSourceRegistration } from "@cogni/ingestion-core";
import { makeCannedGitHubEvents } from "@tests/_fixtures/attribution/fake-github-registration";
import { TEST_NODE_ID } from "@tests/_fixtures/attribution/seed-attribution";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { describe, expect, it } from "vitest";

/** Dedicated scope — avoids epoch/receipt collisions with other attribution suites. */
const SCOPE_ID = "00000000-0000-4000-8000-0000000000cc";
const TEST_PIPELINE = "cogni-v0.0";

/** Monday-aligned week, test-safe range. */
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
} as unknown as Parameters<typeof runCollectPass>[0]["logger"];

describe("[attribution] runCollectPass over webhook-only receipts (stack)", () => {
  it("fills epoch + selection with NO poll adapter", async () => {
    const db = getSeedDb();
    const rawStore = new DrizzleAttributionAdapter(db, SCOPE_ID);

    // 1. Deposit receipts directly — stands in for the Phase-1 receipt seam
    //    (the webhook receiver writes the same ingestion_receipts table).
    const cannedEvents = makeCannedGitHubEvents(EPOCH_MIDPOINT);
    await rawStore.insertIngestionReceipts(
      cannedEvents.map((e) => ({
        receiptId: e.id,
        nodeId: TEST_NODE_ID,
        source: e.source,
        eventType: e.eventType,
        platformUserId: e.platformUserId,
        platformLogin: e.platformLogin ?? null,
        artifactUrl: e.artifactUrl ?? null,
        metadata: e.metadata ?? null,
        payloadHash: e.payloadHash,
        producer: e.source,
        producerVersion: "0.0.0-test",
        eventTime: new Date(e.eventTime),
        retrievedAt: new Date(),
      }))
    );

    // 2. Webhook-only: empty registration Map → no poll adapter for "github".
    const sourceRegistrations = new Map<string, DataSourceRegistration>();

    // 3. Run the in-process collect pass with the validated store wrapper.
    const summary = await runCollectPass(
      {
        attributionStore: createValidatedAttributionStore(rawStore),
        sourceRegistrations,
        registries: createDefaultRegistries(),
        nodeId: TEST_NODE_ID,
        scopeId: SCOPE_ID,
        chainId: 8453,
        logger: mockLogger,
      },
      {
        version: 1,
        scopeId: SCOPE_ID,
        scopeKey: "test-collect-pass",
        epochLengthDays: 7,
        activitySources: {
          github: {
            attributionPipeline: TEST_PIPELINE,
            sourceRefs: ["test-org/test-repo"],
          },
        },
      },
      EPOCH_MIDPOINT.toISOString()
    );

    // Pass proceeded WITHOUT polling — webhook-only source was skipped.
    expect(summary.sourcesPolled).toBe(0);
    expect(summary.epochStatus).toBe("open");

    // ── Assert DB state ──────────────────────────────────────────
    const store = new DrizzleAttributionAdapter(getSeedDb(), SCOPE_ID);

    // Epoch created for the window.
    const epoch = await store.getEpochByWindow(
      TEST_NODE_ID,
      SCOPE_ID,
      PERIOD_START,
      PERIOD_END
    );
    if (!epoch) throw new Error("Epoch not found after collect pass");
    expect(epoch.status).toBe("open");
    expect(epoch.id.toString()).toBe(summary.epochId);

    // Selections materialized over the delivered receipts (proves selection ran
    // without any poll adapter). No user_bindings seeded → hasExistingSelection true.
    const unselected = await store.getSelectionCandidates(
      TEST_NODE_ID,
      epoch.id
    );
    for (const u of unselected) {
      expect(u.hasExistingSelection).toBe(true);
    }

    // Draft evaluation written by the echo enricher.
    const evaluation = await store.getEvaluation(
      epoch.id,
      "cogni.echo.v0",
      "draft"
    );
    expect(evaluation).toBeDefined();
  }, 30_000);
});
