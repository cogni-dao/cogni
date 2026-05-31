// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/external/ingestion/_github-fixture-helper`
 * Purpose: Creates and cleans up real GitHub fixtures (PRs, issues) for external ingestion tests.
 * Scope: Uses `gh` CLI — requires authentication and push access to the target repo. Does not run in CI.
 * Invariants: Fixtures are self-contained — no hardcoded PR numbers.
 * Side-effects: IO (git push, GitHub API — creates PRs, issues on target repo)
 * Links: tests/external/ingestion/github-adapter.external.test.ts
 * @internal
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function exec(cmd: string, opts?: { cwd?: string }): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

export interface GitHubFixtures {
  repo: string;
  branch: string;
  prNumber: number;
  issueNumber: number;
  /** Timestamp just before fixtures were created — use as window.since */
  createdAfter: Date;
  /** Timestamp just after fixtures were created — use as window.until */
  createdBefore: Date;
  tempDir: string;
}

export interface PromotionFixtures {
  repo: string;
  /** Feature branch name */
  featureBranch: string;
  /** PR number: feature → staging (squash merged) */
  stagingPrNumber: number;
  /** The squash merge commit SHA on staging */
  stagingMergeCommitSha: string;
  /** Release branch name (release/*) */
  releaseBranch: string;
  /** PR number: release/* → main (merged) */
  releasePrNumber: number;
  /** Timestamp just before fixtures were created */
  createdAfter: Date;
  /** Timestamp just after fixtures were created */
  createdBefore: Date;
  tempDir: string;
}

/**
 * Creates a merged PR and a closed issue on the target repo.
 * Returns fixture metadata for test assertions + cleanup.
 */
export function createFixtures(repo: string): GitHubFixtures {
  const suffix = Date.now();
  const branch = `test-fixture-${suffix}`;
  const createdAfter = new Date();

  // Clone, branch, push
  const tempDir = mkdtempSync(join(tmpdir(), "cogni-ext-test-"));
  exec(`gh repo clone ${repo} ${tempDir} -- --quiet`);
  exec(`git switch -c ${branch} --quiet`, { cwd: tempDir });

  const ts = new Date().toISOString();
  const fixtureFile = `.ext-test-fixture-${suffix}.txt`;
  execSync(`echo 'external test fixture ${ts}' > ${fixtureFile}`, {
    cwd: tempDir,
  });
  exec(`git add ${fixtureFile}`, { cwd: tempDir });
  exec(
    `git -c user.name='cogni-test' -c user.email='test@cogni.dev' commit -m 'test: external fixture ${suffix}' --quiet`,
    { cwd: tempDir }
  );
  exec(`git push origin ${branch} --quiet`, { cwd: tempDir });

  // Create PR
  const prUrl = exec(
    `gh pr create -R ${repo} --title "Test Fixture ${suffix}" --body "Auto-created by external ingestion tests." --base main --head ${branch}`
  );
  const prNumber = parseInt(prUrl.match(/(\d+)$/)?.[1] ?? "0", 10);

  // Wait for GitHub to compute mergeability before merging
  for (let i = 0; i < 10; i++) {
    try {
      exec(`gh pr merge ${prNumber} -R ${repo} --squash --delete-branch`);
      break;
    } catch (err) {
      if (i === 9) throw err;
      execSync("sleep 3");
    }
  }

  // Create + close issue
  const issueUrl = exec(
    `gh issue create -R ${repo} --title "Test Issue ${suffix}" --body "Auto-created by external ingestion tests."`
  );
  const issueNumber = parseInt(issueUrl.match(/(\d+)$/)?.[1] ?? "0", 10);
  exec(`gh issue close ${issueNumber} -R ${repo}`);

  // Small buffer so GitHub API indexes the data
  const createdBefore = new Date(Date.now() + 60_000);

  return {
    repo,
    branch,
    prNumber,
    issueNumber,
    createdAfter,
    createdBefore,
    tempDir,
  };
}

/**
 * Creates a feature PR merged to staging, then a release PR merged to main.
 * Returns fixture metadata for testing the production-promotion selection policy.
 *
 * Flow:
 *   1. feature branch → PR to staging → squash merge (captures mergeCommitSha)
 *   2. release/* branch from staging → PR to main → merge (commitShas includes staging merge)
 */
export function createPromotionFixtures(repo: string): PromotionFixtures {
  const suffix = Date.now();
  const featureBranch = `test-fixture-${suffix}`;
  const createdAfter = new Date();

  // Clone and create feature branch from staging
  const tempDir = mkdtempSync(join(tmpdir(), "cogni-ext-promo-"));
  exec(`gh repo clone ${repo} ${tempDir} -- --quiet`);
  exec("git fetch origin staging --quiet", { cwd: tempDir });
  exec("git switch staging --quiet", { cwd: tempDir });
  exec(`git switch -c ${featureBranch} --quiet`, { cwd: tempDir });

  // Add fixture file, commit, push
  const ts = new Date().toISOString();
  const fixtureFile = `.ext-test-promo-${suffix}.txt`;
  execSync(`echo 'promotion test fixture ${ts}' > ${fixtureFile}`, {
    cwd: tempDir,
  });
  exec(`git add ${fixtureFile}`, { cwd: tempDir });
  exec(
    `git -c user.name='cogni-test' -c user.email='test@cogni.dev' commit -m 'test: promotion fixture ${suffix}' --quiet`,
    { cwd: tempDir }
  );
  exec(`git push origin ${featureBranch} --quiet`, { cwd: tempDir });

  // Create PR to staging and squash merge
  const stagingPrUrl = exec(
    `gh pr create -R ${repo} --title "Test Promo Staging ${suffix}" --body "Auto-created by external promotion tests." --base staging --head ${featureBranch}`
  );
  const stagingPrNumber = parseInt(
    stagingPrUrl.match(/(\d+)$/)?.[1] ?? "0",
    10
  );

  for (let i = 0; i < 10; i++) {
    try {
      exec(
        `gh pr merge ${stagingPrNumber} -R ${repo} --squash --delete-branch`
      );
      break;
    } catch (err) {
      if (i === 9) throw err;
      execSync("sleep 3");
    }
  }

  // Get the merge commit SHA from the merged staging PR
  const stagingMergeCommitSha = exec(
    `gh pr view ${stagingPrNumber} -R ${repo} --json mergeCommit --jq '.mergeCommit.oid'`
  );
  if (!stagingMergeCommitSha || stagingMergeCommitSha.length < 7) {
    throw new Error(
      `Failed to get mergeCommitSha for staging PR #${stagingPrNumber}`
    );
  }

  // Create release branch from staging (mirroring CI promote job)
  exec("git fetch origin staging --quiet", { cwd: tempDir });
  exec("git switch staging --quiet", { cwd: tempDir });
  exec("git pull origin staging --quiet", { cwd: tempDir });

  const shortSha = stagingMergeCommitSha.slice(0, 8);
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const releaseBranch = `release/${dateStr}-${shortSha}`;
  exec(`git switch -c ${releaseBranch} --quiet`, { cwd: tempDir });
  exec(`git push origin ${releaseBranch} --quiet`, { cwd: tempDir });

  // Create PR from release branch to main and merge
  const releasePrUrl = exec(
    `gh pr create -R ${repo} --title "Release ${dateStr}-${shortSha}" --body "Auto-created release PR for promotion test." --base main --head ${releaseBranch}`
  );
  const releasePrNumber = parseInt(
    releasePrUrl.match(/(\d+)$/)?.[1] ?? "0",
    10
  );

  for (let i = 0; i < 10; i++) {
    try {
      exec(`gh pr merge ${releasePrNumber} -R ${repo} --merge --delete-branch`);
      break;
    } catch (err) {
      if (i === 9) throw err;
      execSync("sleep 3");
    }
  }

  // Sync staging with main so they stay aligned for future runs
  exec("git fetch origin main --quiet", { cwd: tempDir });
  exec("git switch staging --quiet", { cwd: tempDir });
  exec("git merge origin/main --quiet --no-edit", { cwd: tempDir });
  exec("git push origin staging --quiet", { cwd: tempDir });

  const createdBefore = new Date(Date.now() + 60_000);

  return {
    repo,
    featureBranch,
    stagingPrNumber,
    stagingMergeCommitSha,
    releaseBranch,
    releasePrNumber,
    createdAfter,
    createdBefore,
    tempDir,
  };
}

/**
 * Best-effort cleanup of promotion test fixtures.
 */
export function cleanupPromotionFixtures(fixtures: PromotionFixtures): void {
  try {
    // Delete release branch if it survived
    exec(
      `gh api repos/${fixtures.repo}/git/refs/heads/${fixtures.releaseBranch} -X DELETE 2>/dev/null || true`
    );
  } catch {
    // best-effort
  }
  try {
    rmSync(fixtures.tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Best-effort cleanup of test fixtures.
 */
export function cleanupFixtures(fixtures: GitHubFixtures): void {
  // Branch is already deleted by --delete-branch on merge.
  // Close issue if somehow still open.
  try {
    exec(
      `gh issue close ${fixtures.issueNumber} -R ${fixtures.repo} 2>/dev/null || true`
    );
  } catch {
    // best-effort
  }
  try {
    rmSync(fixtures.tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
