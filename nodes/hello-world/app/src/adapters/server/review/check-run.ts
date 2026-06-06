// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/review/check-run`
 * Purpose: Create and update GitHub Check Runs for PR review results.
 * Scope: GitHub API calls for Check Runs only. Does not contain review logic or import feature types.
 * Invariants: Requires checks:write permission on GitHub App.
 * Side-effects: IO (GitHub API calls)
 * Links: task.0153
 * @public
 */

import type { Octokit } from "@octokit/core";

const CHECK_RUN_NAME = "Cogni Git PR Review";

/**
 * Create a Check Run in "in_progress" state.
 * Returns the check_run_id for later update.
 */
export async function createCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string
): Promise<number> {
  const response = await octokit.request(
    "POST /repos/{owner}/{repo}/check-runs",
    {
      owner,
      repo,
      name: CHECK_RUN_NAME,
      head_sha: headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
    }
  );

  return response.data.id;
}

/**
 * Update a Check Run with the final conclusion and summary.
 * @param conclusion - "pass" | "fail" | "neutral" (mapped to GitHub conclusion strings)
 */
export async function updateCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  checkRunId: number,
  conclusion: string,
  summary: string
): Promise<void> {
  await octokit.request(
    "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
    {
      owner,
      repo,
      check_run_id: checkRunId,
      status: "completed",
      conclusion: mapConclusion(conclusion),
      completed_at: new Date().toISOString(),
      output: {
        title: `PR Review: ${conclusion.toUpperCase()}`,
        summary,
      },
    }
  );
}

type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "stale";

function mapConclusion(status: string): CheckRunConclusion {
  switch (status) {
    case "pass":
      return "success";
    case "fail":
      return "failure";
    case "neutral":
      return "neutral";
    default:
      return "neutral";
  }
}
