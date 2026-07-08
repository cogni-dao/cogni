// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/tests/external/sync/canonical-file-sync-e2e.external.test`
 * Purpose: End-to-end proof that `GitHubRepoWriter.syncCanonicalFilesToFork` mirrors node-template's
 *   canonical CI files to a fork repo via the real cogni-operator-test GitHub App, opening exactly one
 *   idempotent PR.
 * Scope: Real GitHub API against the disposable `cogni-test-org` (node-template → test-cog). Constructs
 *   the production adapter from the `cogni-operator-test` App creds; does NOT mock Octokit.
 * Invariants:
 *   - FORWARD_MIRROR_INDEPENDENT_OF_DETECTOR — exercises the node-template→forks axis only.
 *   - BRANCH_IS_IDEMPOTENCY_KEY — a second run reuses the same branch/PR, never opens a second.
 * Side-effects: IO (GitHub App auth + Git Data API write — may open/update a PR on cogni-test-org/test-cog).
 *   The proof PR is left open by default for human review; set SYNC_E2E_CLEANUP=1 to close it in afterAll.
 * Links: src/adapters/server/vcs/github-repo-write.ts, .agents/skills/node-template-sync/SKILL.md,
 *   docs/spec/repo-sync-contract.md, .claude/skills/test-expert (External lane)
 * @internal
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GitHubRepoWriter } from "@/adapters/server";
import type { DeployPlanePort, MirrorCanonicalFilesResult } from "@/ports";

// --- Config (overridable; defaults target the disposable test org) ---------
const SOURCE_OWNER = process.env.SYNC_E2E_SOURCE_OWNER ?? "cogni-test-org";
const SOURCE_REPO = process.env.SYNC_E2E_SOURCE_REPO ?? "node-template";
const SOURCE_REF = process.env.SYNC_E2E_SOURCE_REF ?? "main";
const TARGET_OWNER = process.env.SYNC_E2E_TARGET_OWNER ?? "cogni-test-org";
const TARGET_REPO = process.env.SYNC_E2E_TARGET_REPO ?? "test-cog";

const CANONICAL_PATHS = [
  ".github/workflows/ci.yaml",
  ".github/workflows/pr-build.yml",
  ".github/workflows/pr-lint.yaml",
] as const;

const BRANCH_RE = /^cogni-operator\/sync-canonical-[0-9a-f]{8}$/;

// --- Skip-gate: assert creds BEFORE constructing the App adapter (gotcha #3) -
const appId = process.env.GH_REVIEW_APP_ID;
const privateKeyB64 = process.env.GH_REVIEW_APP_PRIVATE_KEY_BASE64;
const hasCreds = Boolean(appId && privateKeyB64);
const describeIfReady = hasCreds ? describe : describe.skip;

describeIfReady(
  "syncCanonicalFilesToFork · node-template → fork (external e2e)",
  () => {
    let plane: DeployPlanePort;

    beforeAll(() => {
      const privateKey = Buffer.from(
        privateKeyB64 as string,
        "base64"
      ).toString("utf-8");
      plane = new GitHubRepoWriter({ appId: appId as string, privateKey });
    });

    const input = () => ({
      sourceOwner: SOURCE_OWNER,
      sourceRepo: SOURCE_REPO,
      sourceRef: SOURCE_REF,
      targetOwner: TARGET_OWNER,
      targetRepo: TARGET_REPO,
      slug: TARGET_REPO,
      canonicalPaths: [...CANONICAL_PATHS],
    });

    let first: MirrorCanonicalFilesResult;

    it("mirrors the canonical set and returns a well-formed, on-branch result", async () => {
      first = await plane.syncCanonicalFilesToFork(input());

      expect(first.branch).toMatch(BRANCH_RE);
      expect(["no_changes", "pr_opened"]).toContain(first.status);

      if (first.status === "pr_opened") {
        expect(first.prNumber).toBeGreaterThan(0);
        expect(first.prUrl).toContain(`${TARGET_OWNER}/${TARGET_REPO}/pull/`);
        // Only canonical paths may ever be touched by the mirror.
        for (const p of first.changedPaths) {
          expect(CANONICAL_PATHS as readonly string[]).toContain(p);
        }
        expect(first.changedPaths.length).toBeGreaterThan(0);
      } else {
        expect(first.changedPaths).toEqual([]);
      }
    }, 120_000);

    it("is idempotent — a second run reuses the same branch and never opens a second PR", async () => {
      const second = await plane.syncCanonicalFilesToFork(input());

      expect(second.branch).toBe(first.branch);
      if (first.status === "pr_opened" && second.status === "pr_opened") {
        expect(second.prNumber).toBe(first.prNumber);
      }
      // A run that opened a PR must not regress to a *different* outcome shape on replay
      // beyond no_changes (the fork now matches) — never a brand-new PR number.
      expect(["no_changes", "pr_opened"]).toContain(second.status);
    }, 120_000);

    afterAll(async () => {
      if (process.env.SYNC_E2E_CLEANUP !== "1") return;
      if (!first || first.status !== "pr_opened") return;
      const { execSync } = await import("node:child_process");
      try {
        execSync(
          `gh pr close ${first.prNumber} -R ${TARGET_OWNER}/${TARGET_REPO} --delete-branch`,
          { stdio: "ignore" }
        );
      } catch {
        // best-effort cleanup
      }
    });
  }
);
