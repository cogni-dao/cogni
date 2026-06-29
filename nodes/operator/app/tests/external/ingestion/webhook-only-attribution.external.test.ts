// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/tests/external/ingestion/webhook-only-attribution.external.test`
 * Purpose: Prove the attribution epoch fills for a WEBHOOK-ONLY git source — the
 *   regression fixed by reverting #519's fatal SOURCE_NO_ADAPTER throw. git is
 *   webhook-only by design (operator GitHub App webhook ingests; the scheduler-worker
 *   holds no GH App key), so CollectEpoch must NOT crash on the absent poll adapter and
 *   must still SELECT the webhook-deposited receipts into claimants.
 * Scope: Real GitHub (test repo fixtures) + testcontainer Postgres + the real
 *   createAttributionActivities pipeline. NO smee, NO running app — receipts are
 *   deposited directly (the same `ingestion_receipts` table the webhook receiver writes),
 *   then the webhook-only collect path is exercised. Does not run in CI.
 * Invariants: WEBHOOK_ONLY_SOURCE, SOURCE_NO_ADAPTER (loud-at-bootstrap, graceful-at-runtime),
 *   SELECTION_AUTO_POPULATE.
 * Side-effects: IO (GitHub GraphQL, git push, testcontainers PostgreSQL)
 * Links: services/scheduler-worker/src/activities/ledger.ts (resolveStreams), docs/spec/attribution-ledger.md
 * @internal
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultRegistries } from "@cogni/attribution-pipeline-plugins";
import { DrizzleAttributionAdapter } from "@cogni/db-client";
import type { DataSourceRegistration } from "@cogni/ingestion-core";
import { extractChainId, parseRepoSpec } from "@cogni/repo-spec";
import {
  TEST_NODE_ID,
  TEST_WEIGHT_CONFIG,
} from "@tests/_fixtures/attribution/seed-attribution";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { seedTestActor } from "@tests/_fixtures/stack/seed";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type AttributionActivityDeps,
  createAttributionActivities,
} from "../../../../../../services/scheduler-worker/src/activities/ledger";
import { GitHubSourceAdapter } from "../../../../../../services/scheduler-worker/src/adapters/ingestion/github";
import { GitHubAppTokenProvider } from "../../../../../../services/scheduler-worker/src/adapters/ingestion/github-auth";
import {
  cleanupPromotionFixtures,
  createPromotionFixtures,
  type PromotionFixtures,
} from "./_github-fixture-helper";

// ---------------------------------------------------------------------------
// Auth resolution — skip entire suite if no GitHub App credentials available
// ---------------------------------------------------------------------------

const GH_REVIEW_APP_ID = process.env.GH_REVIEW_APP_ID ?? "";
const GH_REVIEW_APP_PRIVATE_KEY_BASE64 =
  process.env.GH_REVIEW_APP_PRIVATE_KEY_BASE64 ?? "";
const TEST_REPO = process.env.E2E_GITHUB_REPO ?? "derekg1729/test-repo";

const hasAppCreds = GH_REVIEW_APP_ID && GH_REVIEW_APP_PRIVATE_KEY_BASE64;
const describeWithAuth = hasAppCreds ? describe : describe.skip;

// Dedicated scope so this suite's epoch never collides with sibling external
// suites (ONE_OPEN_EPOCH is per node+scope; receipts are scope-agnostic + idempotent).
const WEBHOOK_SCOPE_ID = "00000000-0000-4000-8000-0000000000bb";
const ATTRIBUTION_PIPELINE = "cogni-v0.0";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as unknown as AttributionActivityDeps["logger"];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeWithAuth("Webhook-only attribution (external)", () => {
  const db = getSeedDb();
  const ledger = new DrizzleAttributionAdapter(db, WEBHOOK_SCOPE_ID);

  const tokenProvider = new GitHubAppTokenProvider({
    appId: GH_REVIEW_APP_ID,
    privateKey: Buffer.from(
      GH_REVIEW_APP_PRIVATE_KEY_BASE64,
      "base64"
    ).toString("utf-8"),
  });

  // Poll adapter — used ONLY to fetch real merged-PR facts and deposit receipts,
  // standing in for the operator webhook receiver (same `ingestion_receipts` table,
  // same deterministic receipt ids per RECEIPT_IDEMPOTENT). The webhook-only path
  // under test never sees this adapter.
  const githubAdapter = new GitHubSourceAdapter({
    tokenProvider,
    repos: [TEST_REPO],
  });

  const repoSpec = parseRepoSpec(
    readFileSync(join(process.cwd(), ".cogni", "repo-spec.yaml"), "utf-8")
  );
  const chainId = extractChainId(repoSpec);

  // Seeding pipeline: HAS the github poll adapter (to fetch + deposit real PR facts).
  const seedActivities = createAttributionActivities({
    attributionStore: ledger,
    sourceRegistrations: new Map<string, DataSourceRegistration>([
      [
        "github",
        {
          source: "github",
          version: githubAdapter.version,
          poll: githubAdapter,
        },
      ],
    ]),
    nodeId: TEST_NODE_ID,
    scopeId: WEBHOOK_SCOPE_ID,
    chainId,
    registries: createDefaultRegistries(),
    logger: mockLogger,
  });

  // System under test: github configured but NO poll adapter registered — the
  // webhook-only reality (scheduler-worker holds no GH App key by design).
  const webhookOnlyActivities = createAttributionActivities({
    attributionStore: ledger,
    sourceRegistrations: new Map<string, DataSourceRegistration>(),
    nodeId: TEST_NODE_ID,
    scopeId: WEBHOOK_SCOPE_ID,
    chainId,
    registries: createDefaultRegistries(),
    logger: mockLogger,
  });

  let fixtures: PromotionFixtures;

  beforeAll(async () => {
    fixtures = createPromotionFixtures(TEST_REPO);
    await seedTestActor(db);
  }, 120_000);

  afterAll(() => {
    if (fixtures) cleanupPromotionFixtures(fixtures);
  });

  it("resolveStreams skips a poll-adapter-less source instead of throwing (reverts #519)", async () => {
    // Pre-fix: this threw [SOURCE_NO_ADAPTER] and killed CollectEpoch before selection.
    const result = await webhookOnlyActivities.resolveStreams({
      source: "github",
    });
    expect(result.streams).toEqual([]);
  });

  it("epoch fills with claimants from webhook-deposited receipts despite no poll adapter", async () => {
    // 1. Open the epoch (webhook-only pipeline — no poll adapter).
    const epoch = await webhookOnlyActivities.ensureEpochForWindow({
      periodStart: fixtures.createdAfter.toISOString(),
      periodEnd: fixtures.createdBefore.toISOString(),
      weightConfig: TEST_WEIGHT_CONFIG,
    });
    expect(epoch.status).toBe("open");

    // 2. Deposit real merged-PR receipts (stand-in for the webhook receiver). The
    //    fetch uses the seed poll adapter; insertReceipts needs no adapter.
    const collected = await seedActivities.collectFromSource({
      source: "github",
      streams: ["pull_requests"],
      cursorValue: null,
      periodStart: fixtures.createdAfter.toISOString(),
      periodEnd: fixtures.createdBefore.toISOString(),
    });
    expect(collected.events.length).toBeGreaterThan(0);
    await webhookOnlyActivities.insertReceipts({
      events: collected.events,
      producerVersion: githubAdapter.version,
    });

    // 3. Select — the step that the #519 throw prevented from ever running.
    const selection = await webhookOnlyActivities.materializeSelection({
      epochId: epoch.epochId,
      attributionPipeline: ATTRIBUTION_PIPELINE,
    });
    expect(selection.totalReceipts).toBeGreaterThan(0);

    // 4. The merged staging PR is selected into the epoch → a claimant exists.
    const selections = await ledger.getSelectionForEpoch(BigInt(epoch.epochId));
    const stagingSelection = selections.find(
      (s) =>
        s.receiptId === `github:pr:${TEST_REPO}:${fixtures.stagingPrNumber}`
    );
    expect(stagingSelection).toBeDefined();
    expect(stagingSelection?.included).toBe(true);
  });
});
