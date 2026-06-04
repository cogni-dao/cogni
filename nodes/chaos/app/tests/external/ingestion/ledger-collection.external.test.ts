// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/tests/external/ingestion/ledger-collection.external.test`
 * Purpose: Validate ledger activity functions end-to-end against real GitHub API + Postgres.
 * Scope: Creates its own fixtures, exercises createAttributionActivities pipeline. Cleans up after. Does not run in CI.
 * Invariants: Requires GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 in env. Skips gracefully if missing.
 * Side-effects: IO (GitHub GraphQL, git push, testcontainers PostgreSQL)
 * Links: services/scheduler-worker/src/activities/ledger.ts, docs/spec/attribution-ledger.md
 * @internal
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultRegistries } from "@cogni/attribution-pipeline-plugins";
import { DrizzleAttributionAdapter } from "@cogni/db-client";
import type { DataSourceRegistration } from "@cogni/ingestion-core";
import { extractChainId, parseRepoSpec } from "@cogni/repo-spec";
import {
  PROMO_SCOPE_ID,
  TEST_NODE_ID,
  TEST_SCOPE_ID,
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

// ---------------------------------------------------------------------------
// Logger stub
// ---------------------------------------------------------------------------

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

describeWithAuth("Ledger Collection Pipeline (external)", () => {
  const db = getSeedDb();
  const ledger = new DrizzleAttributionAdapter(db, TEST_SCOPE_ID);

  const tokenProvider = new GitHubAppTokenProvider({
    appId: GH_REVIEW_APP_ID,
    privateKey: Buffer.from(
      GH_REVIEW_APP_PRIVATE_KEY_BASE64,
      "base64"
    ).toString("utf-8"),
  });

  const githubAdapter = new GitHubSourceAdapter({
    tokenProvider,
    repos: [TEST_REPO],
  });

  const registrations = new Map<string, DataSourceRegistration>([
    [
      "github",
      {
        source: "github",
        version: githubAdapter.version,
        poll: githubAdapter,
      },
    ],
  ]);

  const repoSpec = parseRepoSpec(
    readFileSync(join(process.cwd(), ".cogni", "repo-spec.yaml"), "utf-8")
  );

  const activities = createAttributionActivities({
    attributionStore: ledger,
    sourceRegistrations: registrations,
    nodeId: TEST_NODE_ID,
    scopeId: TEST_SCOPE_ID,
    chainId: extractChainId(repoSpec),
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

  // ── Epoch lifecycle ───────────────────────────────────────────

  describe("ensureEpochForWindow", () => {
    it("creates epoch and returns isNew=true on first call", async () => {
      const result = await activities.ensureEpochForWindow({
        periodStart: fixtures.createdAfter.toISOString(),
        periodEnd: fixtures.createdBefore.toISOString(),
        weightConfig: TEST_WEIGHT_CONFIG,
      });

      expect(result.isNew).toBe(true);
      expect(result.status).toBe("open");
      expect(result.epochId).toBeTruthy();
    });

    it("returns existing epoch on second call (idempotent)", async () => {
      const result = await activities.ensureEpochForWindow({
        periodStart: fixtures.createdAfter.toISOString(),
        periodEnd: fixtures.createdBefore.toISOString(),
        weightConfig: TEST_WEIGHT_CONFIG,
      });

      expect(result.isNew).toBe(false);
      expect(result.status).toBe("open");
    });

    it("handles closed epoch for same window without throwing", async () => {
      // Close + finalize the epoch created by the first test (same window)
      const existing = await activities.ensureEpochForWindow({
        periodStart: fixtures.createdAfter.toISOString(),
        periodEnd: fixtures.createdBefore.toISOString(),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      expect(existing.isNew).toBe(false);

      await ledger.closeIngestion(
        BigInt(existing.epochId),
        [],
        "test-hash",
        "weight-sum-v0",
        "test-wch"
      );
      await ledger.finalizeEpoch(BigInt(existing.epochId), 0n);

      // Re-calling ensureEpochForWindow should return the finalized epoch
      const result = await activities.ensureEpochForWindow({
        periodStart: fixtures.createdAfter.toISOString(),
        periodEnd: fixtures.createdBefore.toISOString(),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      expect(result.epochId).toBe(existing.epochId);
      expect(result.status).toBe("finalized");
    });
  });

  // ── Multi-pass collection ──────────────────────────────────────

  describe("multi-pass collection per epoch", () => {
    let firstPassCursorValue: string;

    it("pass 1: collects events and saves cursor", async () => {
      const cursor = await activities.loadCursor({
        source: "github",
        stream: "pull_requests",
        sourceRef: TEST_REPO,
      });
      expect(cursor).toBeNull();

      const result = await activities.collectFromSource({
        source: "github",
        streams: ["pull_requests"],
        cursorValue: cursor,
        periodStart: fixtures.createdAfter.toISOString(),
        periodEnd: fixtures.createdBefore.toISOString(),
      });

      expect(result.events.length).toBeGreaterThan(0);

      await activities.insertReceipts({
        events: result.events,
        producerVersion: githubAdapter.version,
      });

      await activities.saveCursor({
        source: "github",
        stream: "pull_requests",
        sourceRef: TEST_REPO,
        cursorValue: result.nextCursorValue,
      });

      firstPassCursorValue = result.nextCursorValue;
    });

    it("pass 2: re-insert is idempotent (no duplicate rows)", async () => {
      const before = await ledger.getReceiptsForWindow(
        TEST_NODE_ID,
        fixtures.createdAfter,
        fixtures.createdBefore
      );

      const result = await activities.collectFromSource({
        source: "github",
        streams: ["pull_requests"],
        cursorValue: null,
        periodStart: fixtures.createdAfter.toISOString(),
        periodEnd: fixtures.createdBefore.toISOString(),
      });

      await activities.insertReceipts({
        events: result.events,
        producerVersion: githubAdapter.version,
      });

      const after = await ledger.getReceiptsForWindow(
        TEST_NODE_ID,
        fixtures.createdAfter,
        fixtures.createdBefore
      );

      expect(after.length).toBe(before.length);
    });

    it("pass 2: cursor loads correctly and stays stable", async () => {
      const cursor = await activities.loadCursor({
        source: "github",
        stream: "pull_requests",
        sourceRef: TEST_REPO,
      });

      expect(cursor).toBe(firstPassCursorValue);

      const result = await activities.collectFromSource({
        source: "github",
        streams: ["pull_requests"],
        cursorValue: cursor,
        periodStart: fixtures.createdAfter.toISOString(),
        periodEnd: fixtures.createdBefore.toISOString(),
      });

      await activities.saveCursor({
        source: "github",
        stream: "pull_requests",
        sourceRef: TEST_REPO,
        cursorValue: result.nextCursorValue,
      });

      const updatedCursor = await activities.loadCursor({
        source: "github",
        stream: "pull_requests",
        sourceRef: TEST_REPO,
      });

      expect(updatedCursor).toBeTruthy();
      expect((updatedCursor as string) >= firstPassCursorValue).toBe(true);
    });
  });

  // ── Cursor monotonicity ────────────────────────────────────────

  describe("cursor monotonicity", () => {
    it("refuses to go backwards — earlier cursor is ignored", async () => {
      await activities.saveCursor({
        source: "github",
        stream: "issues",
        sourceRef: TEST_REPO,
        cursorValue: "2026-12-31T23:59:59Z",
      });

      await activities.saveCursor({
        source: "github",
        stream: "issues",
        sourceRef: TEST_REPO,
        cursorValue: "2026-01-01T00:00:00Z",
      });

      const cursor = await activities.loadCursor({
        source: "github",
        stream: "issues",
        sourceRef: TEST_REPO,
      });

      expect(cursor).toBe("2026-12-31T23:59:59Z");
    });

    it("advances forward when new cursor is later", async () => {
      await activities.saveCursor({
        source: "github",
        stream: "reviews",
        sourceRef: TEST_REPO,
        cursorValue: "2026-01-01T00:00:00Z",
      });

      await activities.saveCursor({
        source: "github",
        stream: "reviews",
        sourceRef: TEST_REPO,
        cursorValue: "2026-06-15T12:00:00Z",
      });

      const cursor = await activities.loadCursor({
        source: "github",
        stream: "reviews",
        sourceRef: TEST_REPO,
      });

      expect(cursor).toBe("2026-06-15T12:00:00Z");
    });
  });

  // ── Cursor type safety ─────────────────────────────────────────

  describe("cursor type correctness", () => {
    it("all GitHub streams use timestamp cursors (ISO format)", () => {
      const streams = githubAdapter.streams();
      for (const stream of streams) {
        expect(stream.cursorType).toBe("timestamp");
      }
    });

    it("cursor values from collect() are valid ISO timestamps", async () => {
      const result = await activities.collectFromSource({
        source: "github",
        streams: ["pull_requests"],
        cursorValue: null,
        periodStart: fixtures.createdAfter.toISOString(),
        periodEnd: fixtures.createdBefore.toISOString(),
      });

      const parsed = new Date(result.nextCursorValue);
      expect(parsed.toISOString()).toBe(result.nextCursorValue);
    });
  });

  // ── Production promotion selection ──────────────────────────────
  // Uses PROMO_SCOPE_ID to avoid epoch collision with the finalized epoch above.

  describe("production promotion selection", () => {
    const promoLedger = new DrizzleAttributionAdapter(db, PROMO_SCOPE_ID);
    const promoActivities = createAttributionActivities({
      attributionStore: promoLedger,
      sourceRegistrations: registrations,
      nodeId: TEST_NODE_ID,
      scopeId: PROMO_SCOPE_ID,
      chainId: extractChainId(repoSpec),
      registries: createDefaultRegistries(),
      logger: mockLogger,
    });

    it("collects both staging and release PRs from the window", async () => {
      const result = await promoActivities.collectFromSource({
        source: "github",
        streams: ["pull_requests"],
        cursorValue: null,
        periodStart: fixtures.createdAfter.toISOString(),
        periodEnd: fixtures.createdBefore.toISOString(),
      });

      const stagingPr = result.events.find(
        (e) => e.id === `github:pr:${TEST_REPO}:${fixtures.stagingPrNumber}`
      );
      const releasePr = result.events.find(
        (e) => e.id === `github:pr:${TEST_REPO}:${fixtures.releasePrNumber}`
      );

      expect(stagingPr).toBeDefined();
      expect(stagingPr?.eventType).toBe("pr_merged");
      expect((stagingPr?.metadata as Record<string, unknown>)?.baseBranch).toBe(
        "staging"
      );
      expect(
        (stagingPr?.metadata as Record<string, unknown>)?.mergeCommitSha
      ).toBe(fixtures.stagingMergeCommitSha);

      expect(releasePr).toBeDefined();
      expect(releasePr?.eventType).toBe("pr_merged");
      expect((releasePr?.metadata as Record<string, unknown>)?.baseBranch).toBe(
        "main"
      );

      // Release PR's commitShas should contain the staging merge commit
      const releaseCommitShas = (releasePr?.metadata as Record<string, unknown>)
        ?.commitShas as string[] | undefined;
      expect(releaseCommitShas).toContain(fixtures.stagingMergeCommitSha);
    });

    it("materializeSelection includes staging PR, excludes release PR", async () => {
      // Create a fresh epoch under PROMO_SCOPE_ID
      const promoEpoch = await promoActivities.ensureEpochForWindow({
        periodStart: fixtures.createdAfter.toISOString(),
        periodEnd: fixtures.createdBefore.toISOString(),
        weightConfig: TEST_WEIGHT_CONFIG,
      });
      expect(promoEpoch.isNew).toBe(true);

      // Ingest PRs into this epoch's window
      const collected = await promoActivities.collectFromSource({
        source: "github",
        streams: ["pull_requests"],
        cursorValue: null,
        periodStart: fixtures.createdAfter.toISOString(),
        periodEnd: fixtures.createdBefore.toISOString(),
      });

      await promoActivities.insertReceipts({
        events: collected.events,
        producerVersion: githubAdapter.version,
      });

      // Run selection
      const selectionResult = await promoActivities.materializeSelection({
        epochId: promoEpoch.epochId,
        attributionPipeline: "cogni-v0.0",
      });

      expect(selectionResult.totalReceipts).toBeGreaterThan(0);

      // Verify selection rows: staging PR included, release PR excluded
      const selections = await promoLedger.getSelectionForEpoch(
        BigInt(promoEpoch.epochId)
      );

      const stagingSelection = selections.find(
        (s) =>
          s.receiptId === `github:pr:${TEST_REPO}:${fixtures.stagingPrNumber}`
      );
      const releaseSelection = selections.find(
        (s) =>
          s.receiptId === `github:pr:${TEST_REPO}:${fixtures.releasePrNumber}`
      );

      expect(stagingSelection).toBeDefined();
      expect(stagingSelection?.included).toBe(true);

      expect(releaseSelection).toBeDefined();
      expect(releaseSelection?.included).toBe(false);
    });
  });
});
