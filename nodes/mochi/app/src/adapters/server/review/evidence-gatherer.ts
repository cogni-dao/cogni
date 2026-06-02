// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/review/evidence-gatherer`
 * Purpose: Pre-fetch PR diff and file list via Octokit with budget-aware truncation.
 * Scope: GitHub API calls for diff fetching. Does not contain review logic.
 * Invariants: Budget truncation applied before passing to LLM.
 * Side-effects: IO (GitHub API calls)
 * Links: task.0153
 * @public
 */

import type { Octokit } from "@octokit/core";

/** Max patch size per file in bytes (100KB). */
const MAX_PATCH_BYTES_PER_FILE = 100_000;

/** Max total patch size in bytes (500KB). */
const MAX_TOTAL_PATCH_BYTES = 500_000;

/** Max number of files to include patches for. */
const MAX_FILES_WITH_PATCHES = 30;

/**
 * Fetch PR evidence from GitHub API with budget-aware truncation.
 */
export async function gatherEvidence(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{
  prNumber: number;
  prTitle: string;
  prBody: string;
  headSha: string;
  baseBranch: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  patches: Array<{ filename: string; patch: string }>;
  totalDiffBytes: number;
}> {
  // Fetch PR details and files in parallel
  const [prResponse, filesResponse] = await Promise.all([
    octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: prNumber,
    }),
    octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);

  const pr = prResponse.data;
  const files = filesResponse.data;

  // Calculate total diff size
  let totalDiffBytes = 0;
  for (const file of files) {
    totalDiffBytes += file.patch?.length ?? 0;
  }

  // Truncate patches with budget awareness
  const patches: Array<{ filename: string; patch: string }> = [];
  let usedBytes = 0;

  for (const file of files.slice(0, MAX_FILES_WITH_PATCHES)) {
    if (!file.patch) continue;

    let patch = file.patch;

    // Per-file truncation
    if (patch.length > MAX_PATCH_BYTES_PER_FILE) {
      patch = `${patch.slice(0, MAX_PATCH_BYTES_PER_FILE)}\n... (truncated)`;
    }

    // Total budget check
    if (usedBytes + patch.length > MAX_TOTAL_PATCH_BYTES) {
      patches.push({
        filename: file.filename,
        patch: "... (budget exceeded, patch omitted)",
      });
      continue;
    }

    usedBytes += patch.length;
    patches.push({ filename: file.filename, patch });
  }

  return {
    prNumber: pr.number,
    prTitle: pr.title,
    prBody: pr.body ?? "",
    headSha: pr.head.sha,
    baseBranch: pr.base.ref,
    changedFiles: pr.changed_files,
    additions: pr.additions,
    deletions: pr.deletions,
    patches,
    totalDiffBytes,
  };
}
