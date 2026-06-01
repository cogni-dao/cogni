// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/tests/external/ingestion/github-adapter.external.test`
 * Purpose: Validate GitHubSourceAdapter against real GitHub API — self-contained fixtures.
 * Scope: Creates its own merged PR + closed issue on the test repo, then collects via adapter. Cleans up after. Does not run in CI.
 * Invariants: Requires GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 in env. Skips gracefully if missing.
 * Side-effects: IO (GitHub API, git push, testcontainers PostgreSQL)
 * Links: services/scheduler-worker/src/adapters/ingestion/github.ts, docs/spec/attribution-ledger.md
 * @internal
 */

import type { InsertReceiptParams } from "@cogni/attribution-ledger";
import { DrizzleAttributionAdapter } from "@cogni/db-client";
import type { ActivityEvent } from "@cogni/ingestion-core";
import {
  OTHER_SCOPE_ID,
  TEST_NODE_ID,
  TEST_WEIGHT_CONFIG,
} from "@tests/_fixtures/attribution/seed-attribution";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { seedTestActor } from "@tests/_fixtures/stack/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubSourceAdapter } from "../../../../../../services/scheduler-worker/src/adapters/ingestion/github";
import { GitHubAppTokenProvider } from "../../../../../../services/scheduler-worker/src/adapters/ingestion/github-auth";
import type { GitHubFixtures } from "./_github-fixture-helper";
import {
  acquireSharedFixtures,
  releaseSharedFixtures,
} from "./_shared-fixtures";

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
// Suite
// ---------------------------------------------------------------------------

describeWithAuth("GitHubSourceAdapter (external)", () => {
  const tokenProvider = new GitHubAppTokenProvider({
    appId: GH_REVIEW_APP_ID,
    privateKey: Buffer.from(
      GH_REVIEW_APP_PRIVATE_KEY_BASE64,
      "base64"
    ).toString("utf-8"),
  });

  const adapter = new GitHubSourceAdapter({
    tokenProvider,
    repos: [TEST_REPO],
  });

  let fixtures: GitHubFixtures;

  beforeAll(() => {
    fixtures = acquireSharedFixtures();
  }, 60_000);

  afterAll(() => {
    releaseSharedFixtures();
  });

  // ── Stream definitions ──────────────────────────────────────────

  it("streams() returns 3 stream definitions", () => {
    const streams = adapter.streams();
    expect(streams).toHaveLength(3);
    const ids = streams.map((s) => s.id);
    expect(ids).toContain("pull_requests");
    expect(ids).toContain("reviews");
    expect(ids).toContain("issues");
  });

  // ── Merged PRs ──────────────────────────────────────────────────

  it("collects merged PRs including our fixture", async () => {
    const result = await adapter.collect({
      streams: ["pull_requests"],
      cursor: null,
      window: {
        since: fixtures.createdAfter,
        until: fixtures.createdBefore,
      },
    });

    expect(result.events.length).toBeGreaterThanOrEqual(1);
    expect(result.nextCursor).toBeDefined();

    const ourPr = result.events.find(
      (e) => e.id === `github:pr:${TEST_REPO}:${fixtures.prNumber}`
    );
    expect(ourPr).toBeDefined();
    expect(ourPr?.eventType).toBe("pr_merged");
    expect(ourPr?.source).toBe("github");
    expect(ourPr?.platformUserId).toBeTruthy();
    expect(ourPr?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(ourPr?.eventTime).toBeInstanceOf(Date);
    expect(ourPr?.artifactUrl).toContain("github.com");
  });

  // ── Closed issues ───────────────────────────────────────────────

  it("collects closed issues including our fixture", async () => {
    expect(fixtures.issueNumber).toBeGreaterThan(0);

    const result = await adapter.collect({
      streams: ["issues"],
      cursor: null,
      window: {
        since: fixtures.createdAfter,
        until: fixtures.createdBefore,
      },
    });

    expect(result.events.length).toBeGreaterThanOrEqual(1);

    const ourIssue = result.events.find(
      (e) => e.id === `github:issue:${TEST_REPO}:${fixtures.issueNumber}`
    );
    expect(ourIssue).toBeDefined();
    expect(ourIssue?.eventType).toBe("issue_closed");
    expect(ourIssue?.source).toBe("github");
    expect(ourIssue?.platformUserId).toBeTruthy();
    expect(ourIssue?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  // ── Reviews (no fixture — just verify the stream doesn't crash) ─

  it("collects reviews without error", async () => {
    const result = await adapter.collect({
      streams: ["reviews"],
      cursor: null,
      window: {
        since: fixtures.createdAfter,
        until: fixtures.createdBefore,
      },
    });

    // May be 0 (no reviews on our fixture PR) — that's fine
    expect(result.events).toBeInstanceOf(Array);
    for (const event of result.events) {
      expect(event.eventType).toBe("review_submitted");
      expect(event.source).toBe("github");
    }
  });

  // ── Determinism ─────────────────────────────────────────────────

  it("deterministic: same window twice yields identical IDs and hashes", async () => {
    const params = {
      streams: ["pull_requests"] as string[],
      cursor: null,
      window: {
        since: fixtures.createdAfter,
        until: fixtures.createdBefore,
      },
    };

    const run1 = await adapter.collect(params);
    const run2 = await adapter.collect(params);

    // Filter to our fixture PR — other test files may concurrently merge PRs
    // into the same repo, so total event counts can differ between runs.
    const fixtureId = `github:pr:${TEST_REPO}:${fixtures.prNumber}`;

    const pr1 = run1.events.find((e) => e.id === fixtureId);
    const pr2 = run2.events.find((e) => e.id === fixtureId);

    expect(pr1).toBeDefined();
    expect(pr2).toBeDefined();
    expect(pr1?.id).toBe(pr2?.id);
    expect(pr1?.payloadHash).toBe(pr2?.payloadHash);
    expect(pr1?.eventType).toBe(pr2?.eventType);
    expect(pr1?.platformUserId).toBe(pr2?.platformUserId);
    expect(pr1?.eventTime.toISOString()).toBe(pr2?.eventTime.toISOString());
  });

  // ── Ledger round-trip ───────────────────────────────────────────

  describe("ledger round-trip", () => {
    const db = getSeedDb();
    // Use OTHER_SCOPE_ID to avoid ONE_OPEN_EPOCH collision with ledger-collection tests
    const ledger = new DrizzleAttributionAdapter(db, OTHER_SCOPE_ID);

    beforeAll(async () => {
      await seedTestActor(db);
      await ledger.createEpoch({
        nodeId: TEST_NODE_ID,
        scopeId: OTHER_SCOPE_ID,
        periodStart: fixtures.createdAfter,
        periodEnd: fixtures.createdBefore,
        weightConfig: TEST_WEIGHT_CONFIG,
      });
    });

    it("adapter events insert into ledger and survive re-insert (idempotent)", async () => {
      const result = await adapter.collect({
        streams: ["pull_requests"],
        cursor: null,
        window: {
          since: fixtures.createdAfter,
          until: fixtures.createdBefore,
        },
      });
      expect(result.events.length).toBeGreaterThan(0);

      const params: InsertReceiptParams[] = result.events.map(
        (e: ActivityEvent) => ({
          receiptId: e.id,
          nodeId: TEST_NODE_ID,
          source: e.source,
          eventType: e.eventType,
          platformUserId: e.platformUserId,
          platformLogin: e.platformLogin,
          artifactUrl: e.artifactUrl,
          metadata: e.metadata,
          payloadHash: e.payloadHash,
          producer: adapter.source,
          producerVersion: adapter.version,
          eventTime: e.eventTime,
          retrievedAt: new Date(),
        })
      );

      await ledger.insertIngestionReceipts(params);

      const stored = await ledger.getReceiptsForWindow(
        TEST_NODE_ID,
        fixtures.createdAfter,
        fixtures.createdBefore
      );
      expect(stored.length).toBeGreaterThanOrEqual(result.events.length);

      // Re-insert — idempotent, no error
      await expect(
        ledger.insertIngestionReceipts(params)
      ).resolves.toBeUndefined();
    });
  });
});
