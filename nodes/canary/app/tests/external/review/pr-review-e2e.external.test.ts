// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/tests/external/review/pr-review-e2e.external.test`
 * Purpose: End-to-end PR review pipeline: open PR → check run created → review completes → comment posted.
 * Scope: Validates the full review pipeline against a running app with real GitHub API and real LLM calls. Does NOT test with mocks — hits real GitHub, real app, real LiteLLM.
 * Invariants: Requires dev stack + smee, GH_REVIEW_APP credentials, system tenant seeded.
 * Side-effects: IO (git push, GitHub API, LLM calls billed to system tenant)
 * Links: task.0153, src/app/_facades/review/dispatch.server.ts
 * @internal
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Config — skip entire suite if prerequisites missing
// ---------------------------------------------------------------------------

const GH_REVIEW_APP_ID = process.env.GH_REVIEW_APP_ID ?? "";
const GH_REVIEW_APP_PRIVATE_KEY_BASE64 =
  process.env.GH_REVIEW_APP_PRIVATE_KEY_BASE64 ?? "";
const TEST_REPO = process.env.E2E_GITHUB_REPO ?? "derekg1729/test-repo";

// Need: gh CLI, GH App creds, running app with webhook + smee + LiteLLM
const canRun = !!(GH_REVIEW_APP_ID && GH_REVIEW_APP_PRIVATE_KEY_BASE64);
const describeIfReady = canRun ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3_000;
const CHECK_RUN_NAME = "Cogni Git PR Review";

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

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  output?: { summary: string | null };
}

function getCheckRuns(repo: string, sha: string): CheckRun[] {
  const json = exec(
    `gh api repos/${repo}/commits/${sha}/check-runs --jq '.check_runs | map({id, name, status, conclusion, output: {summary: .output.summary}})'`
  );
  return JSON.parse(json) as CheckRun[];
}

interface PrComment {
  id: number;
  body: string;
  user: { login: string };
}

function getPrComments(repo: string, prNumber: number): PrComment[] {
  const json = exec(
    `gh api repos/${repo}/issues/${prNumber}/comments --jq 'map({id, body, user: {login: .user.login}})'`
  );
  return JSON.parse(json) as PrComment[];
}

// ---------------------------------------------------------------------------
// Suite — shared fixture: one PR, two tests
// ---------------------------------------------------------------------------

describeIfReady("PR Review E2E (external)", () => {
  const branch = `review-e2e-${Date.now()}`;
  let tempDir = "";
  let prNumber = 0;
  let headSha = "";

  beforeAll(() => {
    // Verify prerequisites
    exec("gh --version");

    // Push + open PR
    tempDir = mkdtempSync(join(tmpdir(), "cogni-review-e2e-"));
    exec(`gh repo clone ${TEST_REPO} ${tempDir} -- --quiet`);
    exec(`git switch -c ${branch} --quiet`, { cwd: tempDir });

    const ts = new Date().toISOString();
    execSync(`echo 'review e2e test ${ts}' > .review-test.txt`, {
      cwd: tempDir,
    });
    exec("git add .review-test.txt", { cwd: tempDir });
    exec(
      `git -c user.name='cogni-bot' -c user.email='actions@users.noreply.github.com' commit -m 'test(review): e2e ${Date.now()}' --quiet`,
      { cwd: tempDir }
    );
    exec(`git push origin ${branch} --quiet`, { cwd: tempDir });

    headSha = exec("git rev-parse HEAD", { cwd: tempDir });

    const prUrl = exec(
      `gh pr create -R ${TEST_REPO} --title "Review E2E ${branch}" --body "Auto-created for PR review E2E test." --base main --head ${branch}`
    );
    const match = prUrl.match(/(\d+)$/);
    prNumber = parseInt(match?.[1] ?? "0", 10);
  }, 30_000);

  afterAll(() => {
    if (prNumber) {
      try {
        exec(`gh pr close ${prNumber} -R ${TEST_REPO} --delete-branch`);
      } catch {
        // best-effort
      }
    }
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  // ── Test 1: Check run appears (fast — proves webhook → dispatch → GitHub API) ──

  it("check run created as in_progress within 30s of PR open", async () => {
    expect(prNumber).toBeGreaterThan(0);

    const TIMEOUT_MS = 30_000;
    let checkRun: CheckRun | undefined;
    const start = Date.now();

    while (Date.now() - start < TIMEOUT_MS) {
      const runs = getCheckRuns(TEST_REPO, headSha);
      checkRun = runs.find((r) => r.name === CHECK_RUN_NAME);
      if (checkRun) break;
      await sleep(POLL_INTERVAL_MS);
    }

    expect(checkRun).toBeDefined();
    expect(checkRun?.name).toBe(CHECK_RUN_NAME);
    // Should be in_progress or already completed (if fast)
    expect(checkRun?.status).toMatch(/^(in_progress|completed)$/);
  }, 45_000);

  // ── Test 2: Review completes + comment posted (slow — full LLM pipeline) ──

  it("check run completes and PR comment posted", async () => {
    expect(prNumber).toBeGreaterThan(0);

    // Poll for check run completion (LLM call takes 30-120s)
    const CHECK_TIMEOUT_MS = 180_000;
    let checkRun: CheckRun | undefined;
    const checkStart = Date.now();

    while (Date.now() - checkStart < CHECK_TIMEOUT_MS) {
      const runs = getCheckRuns(TEST_REPO, headSha);
      checkRun = runs.find((r) => r.name === CHECK_RUN_NAME);
      if (checkRun?.status === "completed") break;
      await sleep(POLL_INTERVAL_MS);
    }

    expect(checkRun?.status).toBe("completed");
    expect(checkRun?.conclusion).toMatch(/^(success|failure)$/);

    // Poll for PR comment (should appear shortly after check run)
    const COMMENT_TIMEOUT_MS = 15_000;
    let reviewComment: PrComment | undefined;
    const commentStart = Date.now();

    while (Date.now() - commentStart < COMMENT_TIMEOUT_MS) {
      const comments = getPrComments(TEST_REPO, prNumber);
      reviewComment = comments.find((c) => c.body.includes("Cogni Review"));
      if (reviewComment) break;
      await sleep(POLL_INTERVAL_MS);
    }

    expect(reviewComment).toBeDefined();
    expect(reviewComment?.body).toContain("Cogni Review");
    // Should contain gate counts line
    expect(reviewComment?.body).toMatch(/passed.*failed.*neutral/);
    // Should contain blocker details or gate counts
    expect(reviewComment?.body).toMatch(/Blockers|Gates/i);

    // Governance deep link lives on Check Run "View Details" page, not PR comment
    // DAO vote link only appears on failures — verify conditionally
    const checkRunSummary = checkRun?.output?.summary ?? "";
    if (checkRun?.conclusion === "failure") {
      expect(checkRunSummary).toContain("Propose DAO Vote to Merge");
      expect(checkRunSummary).toMatch(
        /action=merge.*target=change.*resource=\d+.*vcs=github/
      );
    }
    // Always: summary contains gate results
    expect(checkRunSummary).toMatch(/passed.*failed.*neutral/);
  }, 210_000);
});
