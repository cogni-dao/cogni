// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/tests/external/ingestion/webhook-poll-dedup.external.test`
 * Purpose: Verify cross-path idempotency — webhook + poll for the same merged PR produce no duplicate receipts.
 * Scope: Creates + merges a PR (webhook fires), waits for receipt in DB, then runs the real poll adapter + activity insert. Asserts count unchanged. Does not run in CI.
 * Invariants: RECEIPT_IDEMPOTENT, ACTIVITY_IDEMPOTENT (same receipt_id from both paths → ON CONFLICT DO NOTHING)
 * Side-effects: IO (git push, GitHub API, PostgreSQL reads)
 * Links: src/adapters/server/ingestion/github-webhook.ts, services/scheduler-worker/src/adapters/ingestion/github.ts
 * @internal
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DrizzleAttributionAdapter } from "@cogni/db-client";
import { createServiceDbClient } from "@cogni/db-client/service";
import type { DataSourceRegistration } from "@cogni/ingestion-core";
import {
  extractChainId,
  extractScopeId,
  parseRepoSpec,
} from "@cogni/repo-spec";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAttributionActivities } from "../../../../../../services/scheduler-worker/src/activities/ledger";
import { GitHubSourceAdapter } from "../../../../../../services/scheduler-worker/src/adapters/ingestion/github";
import { GitHubAppTokenProvider } from "../../../../../../services/scheduler-worker/src/adapters/ingestion/github-auth";
import type { GitHubFixtures } from "./_github-fixture-helper";
import {
  acquireSharedFixtures,
  releaseSharedFixtures,
} from "./_shared-fixtures";

// ---------------------------------------------------------------------------
// Config — skip if prerequisites missing
// ---------------------------------------------------------------------------

const DATABASE_SERVICE_URL =
  process.env.E2E_DATABASE_SERVICE_URL ??
  process.env.DATABASE_SERVICE_URL ??
  "";
const GH_REVIEW_APP_ID = process.env.GH_REVIEW_APP_ID ?? "";
const GH_REVIEW_APP_PRIVATE_KEY_BASE64 =
  process.env.GH_REVIEW_APP_PRIVATE_KEY_BASE64 ?? "";
const TEST_REPO = process.env.E2E_GITHUB_REPO ?? "derekg1729/test-repo";

const canRun =
  !!DATABASE_SERVICE_URL &&
  !!GH_REVIEW_APP_ID &&
  !!GH_REVIEW_APP_PRIVATE_KEY_BASE64;
const describeIfReady = canRun ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3_000;
const WEBHOOK_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIfReady("Webhook + Poll Dedup (external)", () => {
  const db = createServiceDbClient(DATABASE_SERVICE_URL);
  let fixtures: GitHubFixtures;

  beforeAll(() => {
    fixtures = acquireSharedFixtures();
  }, 60_000);

  afterAll(() => {
    releaseSharedFixtures();
  });

  it(
    "webhook receipt + poll insert produces no duplicate",
    async () => {
      // ── Phase 1: Wait for webhook receipt in DB ────────────────────
      const expectedReceiptId = `github:pr:${TEST_REPO}:${fixtures.prNumber}`;
      let found = false;
      const startTime = Date.now();

      while (Date.now() - startTime < WEBHOOK_TIMEOUT_MS) {
        const rows = await db.execute(
          sql`SELECT receipt_id, producer FROM ingestion_receipts
              WHERE receipt_id = ${expectedReceiptId}`
        );
        if (rows.length > 0) {
          expect(
            String((rows[0] as Record<string, unknown>).producer)
          ).toContain("webhook");
          found = true;
          break;
        }
        await sleep(POLL_INTERVAL_MS);
      }

      expect(found).toBe(true);

      // ── Phase 2: Run poll adapter + real insert path ──────────────
      const tokenProvider = new GitHubAppTokenProvider({
        appId: GH_REVIEW_APP_ID,
        privateKey: Buffer.from(
          GH_REVIEW_APP_PRIVATE_KEY_BASE64,
          "base64"
        ).toString("utf-8"),
      });

      const pollAdapter = new GitHubSourceAdapter({
        tokenProvider,
        repos: [TEST_REPO],
      });

      // Use the same node_id as the running app (from repo-spec) so that
      // poll-path inserts hit the same composite PK (node_id, receipt_id)
      // as webhook-path inserts — otherwise ON CONFLICT DO NOTHING won't fire.
      const repoSpecYaml = readFileSync(
        join(process.cwd(), ".cogni", "repo-spec.yaml"),
        "utf-8"
      );
      const repoSpec = parseRepoSpec(repoSpecYaml);
      const LIVE_NODE_ID = repoSpec.node_id;
      const LIVE_SCOPE_ID = extractScopeId(repoSpec);
      const ledger = new DrizzleAttributionAdapter(db, LIVE_SCOPE_ID);

      const registrations = new Map<string, DataSourceRegistration>([
        [
          "github",
          {
            source: "github",
            version: pollAdapter.version,
            poll: pollAdapter,
          },
        ],
      ]);

      const activities = createAttributionActivities({
        attributionStore: ledger,
        sourceRegistrations: registrations,
        nodeId: LIVE_NODE_ID,
        scopeId: LIVE_SCOPE_ID,
        chainId: extractChainId(repoSpec),
        // Only collectFromSource + insertReceipts used; registries unused.
        registries: {} as never,
        logger: mockLogger as never,
      });

      // Collect via poll — same PR should appear
      const result = await activities.collectFromSource({
        source: "github",
        streams: ["pull_requests"],
        cursorValue: null,
        periodStart: new Date(
          fixtures.createdAfter.getTime() - 120_000
        ).toISOString(),
        periodEnd: fixtures.createdBefore.toISOString(),
      });

      const pollEvent = result.events.find((e) => e.id === expectedReceiptId);
      expect(pollEvent).toBeDefined();

      // Insert via the real activity path — ON CONFLICT DO NOTHING
      await activities.insertReceipts({
        events: result.events,
        producerVersion: pollAdapter.version,
      });

      // ── Phase 3: Verify no duplicates ─────────────────────────────
      const afterRows = await db.execute(
        sql`SELECT count(*)::text as count FROM ingestion_receipts
            WHERE receipt_id = ${expectedReceiptId}`
      );
      const count = parseInt(
        String((afterRows[0] as Record<string, unknown>)?.count ?? "0"),
        10
      );

      // Exactly 1 — webhook receipt persisted, poll didn't duplicate
      expect(count).toBe(1);

      // Original webhook producer is preserved (first-writer-wins)
      const finalRows = await db.execute(
        sql`SELECT producer FROM ingestion_receipts
            WHERE receipt_id = ${expectedReceiptId}`
      );
      expect(
        String((finalRows[0] as Record<string, unknown>).producer)
      ).toContain("webhook");
    },
    WEBHOOK_TIMEOUT_MS + 60_000
  );
});
