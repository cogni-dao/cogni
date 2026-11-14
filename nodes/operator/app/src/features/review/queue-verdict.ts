// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/review/queue-verdict`
 * Purpose: Pure decisions for carrying a PR's head review verdict onto its merge-queue commit
 *   (task.5438). GitHub requires every required status check to also report on the queue's
 *   merge-group commit; the review App posts `Cogni Git PR Review` only on the PR head. This module
 *   parses the queue push and decides the verdict to copy. All GitHub I/O lives in the review adapter.
 * Scope: Pure functions over plain data. No IO, no LLM.
 * Invariants:
 *   - QUEUE_REF_ONLY: only `refs/heads/gh-readonly-queue/<base>/pr-<N>-<sha>` pushes of the operator
 *     parent repo produce a copy; every other push is ignored.
 *   - OWN_APP_ONLY: only a check run written by the executing review App counts as the head verdict;
 *     an agent- or foreign-app-written check of the same name never does.
 *   - NEVER_NEUTRAL_NEVER_SKIP: the copy is `success` or `failure`. A missing, unfinished or
 *     non-success head verdict yields `failure` ("NOT REVIEWED AT HEAD"), because a missing check
 *     would stall the queue entry for its whole response timeout and eject it.
 *   - LATEST_COMPLETED_WINS: among the App's completed runs of that name on the head SHA, the one with
 *     the highest id (GitHub ids are monotonic) is the verdict.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/merge-queue-required-checks, task.5438, story.5145
 * @public
 */

/** The check the review App writes on the PR head and this module mirrors onto the queue commit. */
export const QUEUE_VERDICT_CHECK_NAME = "Cogni Git PR Review";

export const NOT_REVIEWED_TITLE = "PR Review: NOT REVIEWED AT HEAD";

const QUEUE_REF =
  /^refs\/heads\/gh-readonly-queue\/(.+)\/pr-(\d+)-([0-9a-f]{40})$/i;
const SHA40 = /^[0-9a-f]{40}$/i;
const ZERO_SHA = /^0{40}$/;

/** A merge-queue push narrowed to what the copy needs. */
export interface QueuePush {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  /** The queue's merge-group commit (the push `after` SHA) that must carry the check. */
  readonly queueSha: string;
}

/** One check run on the PR head SHA, as read from GitHub. */
export interface HeadCheckRun {
  readonly id: number;
  readonly name: string;
  /** Integration id that wrote the run (`app.id`); null when GitHub reports none. */
  readonly appId: number | null;
  readonly status: string;
  readonly conclusion: string | null;
  readonly htmlUrl: string | null;
}

export type QueueVerdictOutcome =
  | "copied_success"
  | "copied_failure"
  | "not_reviewed";

export interface QueueVerdict {
  readonly outcome: QueueVerdictOutcome;
  readonly conclusion: "success" | "failure";
  readonly title: string;
  readonly summary: string;
  /** The head check run the verdict was copied from; null when there was none. */
  readonly sourceCheckRunId: number | null;
}

/** Parse the PR number out of a merge-queue ref; null for any other ref. */
export function parseQueueRef(
  ref: unknown
): { readonly baseBranch: string; readonly prNumber: number } | null {
  if (typeof ref !== "string") return null;
  const match = QUEUE_REF.exec(ref);
  if (!match) return null;
  const prNumber = Number(match[2]);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) return null;
  return { baseBranch: match[1] as string, prNumber };
}

/**
 * Narrow a verified GitHub `push` payload to a queue push of the given parent repo, or null.
 * A deleted queue branch (all-zero `after`) is not a copy target.
 */
export function extractQueuePush(
  payload: Record<string, unknown>,
  parent: { readonly owner: string; readonly repo: string }
): QueuePush | null {
  const repository = payload.repository as Record<string, unknown> | undefined;
  const owner = (repository?.owner as Record<string, unknown> | undefined)
    ?.login;
  const repo = repository?.name;
  if (typeof owner !== "string" || typeof repo !== "string") return null;
  if (
    owner.toLowerCase() !== parent.owner.toLowerCase() ||
    repo.toLowerCase() !== parent.repo.toLowerCase()
  ) {
    return null;
  }
  const queueRef = parseQueueRef(payload.ref);
  if (!queueRef) return null;
  const after = payload.after;
  if (
    payload.deleted === true ||
    typeof after !== "string" ||
    !SHA40.test(after) ||
    ZERO_SHA.test(after)
  ) {
    return null;
  }
  return { owner, repo, prNumber: queueRef.prNumber, queueSha: after };
}

/** The review App's latest completed run of the verdict check on the head, or null. */
export function selectHeadVerdictRun(
  runs: readonly HeadCheckRun[],
  reviewAppId: number
): HeadCheckRun | null {
  let latest: HeadCheckRun | null = null;
  for (const run of runs) {
    if (run.name !== QUEUE_VERDICT_CHECK_NAME) continue;
    if (run.appId !== reviewAppId) continue;
    if (run.status !== "completed") continue;
    if (latest === null || run.id > latest.id) latest = run;
  }
  return latest;
}

/** Decide the verdict to write on the queue commit from the PR head's check runs. */
export function decideQueueVerdict(input: {
  readonly headSha: string;
  readonly headRuns: readonly HeadCheckRun[];
  readonly reviewAppId: number;
}): QueueVerdict {
  const source = selectHeadVerdictRun(input.headRuns, input.reviewAppId);
  const head8 = input.headSha.slice(0, 8);
  if (!source) {
    return {
      outcome: "not_reviewed",
      conclusion: "failure",
      title: NOT_REVIEWED_TITLE,
      summary:
        `No completed \`${QUEUE_VERDICT_CHECK_NAME}\` check written by the review App exists on PR head ${input.headSha}. ` +
        "Request a review of this head (POST /api/v1/vcs/review), then re-queue the PR.",
      sourceCheckRunId: null,
    };
  }
  const link = source.htmlUrl ?? `check run ${source.id}`;
  const provenance = `Copied from ${link} at head ${input.headSha}`;
  if (source.conclusion === "success") {
    return {
      outcome: "copied_success",
      conclusion: "success",
      title: `PR Review: PASSED AT HEAD ${head8}`,
      summary: provenance,
      sourceCheckRunId: source.id,
    };
  }
  // failure, neutral, cancelled, timed_out, action_required, stale, skipped, null: none is a pass.
  return {
    outcome: "copied_failure",
    conclusion: "failure",
    title:
      source.conclusion === "failure"
        ? `PR Review: FAILED AT HEAD ${head8}`
        : NOT_REVIEWED_TITLE,
    summary: `${provenance}. Head verdict was \`${source.conclusion ?? "none"}\`, not \`success\`.`,
    sourceCheckRunId: source.id,
  };
}
