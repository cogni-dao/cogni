// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/review/pr-comment`
 * Purpose: Post PR comments with staleness guard.
 * Scope: GitHub API calls for PR comments only. Does not contain review logic.
 * Invariants: Staleness guard — skip if HEAD SHA changed during review.
 * Side-effects: IO (GitHub API calls)
 * Links: task.0153
 * @public
 */

import type { Octokit } from "@octokit/core";

/**
 * Post a PR comment with staleness guard.
 * Fetches current HEAD SHA before posting — skips if it changed during review.
 *
 * @returns true if comment was posted, false if skipped due to staleness
 */
export async function postPrComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  expectedHeadSha: string,
  body: string
): Promise<boolean> {
  // Staleness guard: check current HEAD SHA
  const prResponse = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    { owner, repo, pull_number: prNumber }
  );

  const currentSha = prResponse.data.head.sha;
  if (currentSha !== expectedHeadSha) {
    // PR was updated during review — skip comment to avoid stale results
    return false;
  }

  await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner,
      repo,
      issue_number: prNumber,
      body,
    }
  );

  return true;
}
