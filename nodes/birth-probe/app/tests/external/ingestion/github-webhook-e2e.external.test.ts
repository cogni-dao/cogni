// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/tests/external/ingestion/github-webhook-e2e.external.test`
 * Purpose: GitHub webhook end-to-end: push + PR to test-repo, then poll live DB for ingestion receipts.
 * Scope: Validates the full webhook pipeline against a running app. No mocks, no testcontainers — hits real GitHub, real app, real DB. Does NOT test signature verification (covered by unit tests).
 * Invariants: RECEIPT_IDEMPOTENT, WEBHOOK_VERIFY_BEFORE_NORMALIZE
 * Side-effects: IO (git push, GitHub API, PostgreSQL queries via drizzle)
 * Links: src/app/api/internal/webhooks/[source]/route.ts, src/adapters/server/ingestion/github-webhook.ts
 * @internal
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceDbClient } from "@cogni/db-client/service";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Config — skip entire suite if prerequisites missing
// ---------------------------------------------------------------------------

// E2E_DATABASE_SERVICE_URL overrides DATABASE_SERVICE_URL so testcontainers
// globalSetup doesn't clobber the connection to the live dev stack DB.
const DATABASE_SERVICE_URL =
  process.env.E2E_DATABASE_SERVICE_URL ??
  process.env.DATABASE_SERVICE_URL ??
  "";
const TEST_REPO = process.env.E2E_GITHUB_REPO ?? "derekg1729/test-repo";

// Need: gh CLI, running app with webhook + smee configured, DB access
const canRun = !!DATABASE_SERVICE_URL;
const describeIfReady = canRun ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 90_000;

function exec(cmd: string, opts?: { cwd?: string }): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    ...opts,
  }).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIfReady("Webhook Round-Trip (external)", () => {
  const branch = `webhook-e2e-${Date.now()}`;
  const db = createServiceDbClient(DATABASE_SERVICE_URL);
  let tempDir = "";
  let prNumber = "";

  afterAll(() => {
    // Close PR + delete branch
    if (prNumber) {
      try {
        exec(`gh pr close ${prNumber} -R ${TEST_REPO} --delete-branch`);
      } catch {
        // best-effort
      }
    }

    // Remove temp dir
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  it(
    "push + PR triggers webhook → receipts appear in DB",
    async () => {
      // Verify prerequisites
      exec("gh --version");

      // --- Phase 1: Push + open PR ---
      tempDir = mkdtempSync(join(tmpdir(), "cogni-webhook-e2e-"));
      exec(`gh repo clone ${TEST_REPO} ${tempDir} -- --quiet`);
      exec(`git switch -c ${branch} --quiet`, { cwd: tempDir });

      const ts = new Date().toISOString();
      execSync(`echo 'webhook roundtrip ${ts}' > .webhook-test.txt`, {
        cwd: tempDir,
      });
      exec("git add .webhook-test.txt", { cwd: tempDir });
      exec(
        `git -c user.name='cogni-bot' -c user.email='actions@users.noreply.github.com' commit -m 'test(webhook): roundtrip ${Date.now()}' --quiet`,
        { cwd: tempDir }
      );
      exec(`git push origin ${branch} --quiet`, { cwd: tempDir });

      const prUrl = exec(
        `gh pr create -R ${TEST_REPO} --title "Webhook E2E ${branch}" --body "Auto-created for webhook round-trip test." --base main --head ${branch}`
      );
      const match = prUrl.match(/(\d+)$/);
      prNumber = match?.[1] ?? "";
      expect(prNumber).toBeTruthy();

      // --- Phase 2: Poll DB for receipt matching this specific PR ---
      const expectedPrReceiptId = `github:pr:${TEST_REPO}:${prNumber}:opened`;
      const startTime = Date.now();
      let found = false;

      while (Date.now() - startTime < POLL_TIMEOUT_MS) {
        const rows = await db.execute(
          sql`SELECT receipt_id, event_type FROM ingestion_receipts
              WHERE receipt_id = ${expectedPrReceiptId}`
        );
        if (rows.length > 0) {
          const row = rows[0] as Record<string, unknown>;
          expect(String(row.event_type)).toBe("pr_opened");
          found = true;
          break;
        }
        await sleep(POLL_INTERVAL_MS);
      }

      expect(found).toBe(true);
    },
    POLL_TIMEOUT_MS + 30_000
  );
});
