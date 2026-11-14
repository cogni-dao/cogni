// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/review/queue-verdict.server`
 * Purpose: Carry a PR's head review verdict onto its merge-queue commit so `Cogni Git PR Review` can
 *   be a GitHub-required check on the operator repo (task.5438). GitHub requires every required
 *   check to also report on the queue's merge-group commit; the review App posts it only on the PR
 *   head, so without this copy a required review would stall every queued PR for the response
 *   timeout and eject it.
 * Scope: Webhook-triggered facade. Narrows a verified `push` to a queue push of the operator parent
 *   repo, reads the head verdict through the review GitHub plane, applies the pure decision, and
 *   writes the same-named check on the queue commit. No LLM, no merge, no policy.
 * Invariants:
 *   - PARENT_REPO_ONLY: acts only when the pushed repo is `NODE_SUBMODULE_PARENT_OWNER/REPO`.
 *     Node repos cannot request reviews yet (task.5448) and do not require this check.
 *   - OWN_APP_ONLY: the verdict source is a check run whose `app.id` is this env's `GH_REVIEW_APP_ID`.
 *   - NEVER_SKIP_SILENTLY: a missing or non-passing head verdict is written as `failure`; a copy that
 *     cannot be written throws so the webhook delivery fails loudly and can be redelivered.
 *   - IDEMPOTENT_ON_QUEUE_SHA: a completed verdict by this App already on the queue commit is a no-op
 *     (`skipped_exists`), so a GitHub redelivery never double-writes.
 *   - ONE_EVENT_PER_COPY: exactly one structured event per handled queue push.
 * Side-effects: IO (GitHub REST reads + one check-run write via the review plane)
 * Links: task.5438, story.5145, https://cognidao.org/knowledge/merge-queue-required-checks,
 *   features/review/queue-verdict.ts, adapters/server/review/github-review.adapter.ts
 * @public
 */

import type { Logger } from "pino";
import { createReviewGithubPlane } from "@/bootstrap/review/resolve-review-route";
import {
  decideQueueVerdict,
  extractQueuePush,
} from "@/features/review/queue-verdict";
import type { ServerEnv } from "@/shared/env";
import { EVENT_NAMES } from "@/shared/observability";

type QueueCopyOutcome =
  | "copied_success"
  | "copied_failure"
  | "not_reviewed"
  | "skipped_exists";

/**
 * Copy the head review verdict onto a merge-queue commit when the verified `push` is one.
 * Every other push returns immediately. Failures are logged and rethrown so the webhook cannot
 * acknowledge a copy that was never written.
 */
export async function dispatchQueueReviewVerdict(
  payload: Record<string, unknown>,
  env: ServerEnv,
  log: Logger
): Promise<void> {
  const parentOwner = env.NODE_SUBMODULE_PARENT_OWNER;
  const parentRepo = env.NODE_SUBMODULE_PARENT_REPO;
  if (!parentOwner || !parentRepo) return;
  const push = extractQueuePush(payload, {
    owner: parentOwner,
    repo: parentRepo,
  });
  if (!push) return;

  const startedAt = Date.now();
  const base = {
    event: EVENT_NAMES.REVIEW_QUEUE_VERDICT_COMPLETE,
    repo: `${push.owner}/${push.repo}`,
    prNumber: push.prNumber,
    queueSha: push.queueSha,
    queueSha8: push.queueSha.slice(0, 8),
  };
  try {
    const plane = createReviewGithubPlane(log);
    const reviewAppId = Number(env.GH_REVIEW_APP_ID);
    if (!plane || !Number.isSafeInteger(reviewAppId) || reviewAppId < 1) {
      throw new Error("review App not configured (GH_REVIEW_APP_ID/KEY)");
    }

    const inputs = await plane.readQueueVerdictInputs(push);
    if (inputs.queueHasVerdict) {
      logOutcome(log, base, "skipped_exists", {
        headSha8: inputs.headSha.slice(0, 8),
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const verdict = decideQueueVerdict({
      headSha: inputs.headSha,
      headRuns: inputs.headRuns,
      reviewAppId,
    });
    const checkRunId = await plane.writeQueueVerdict({
      installationId: inputs.installationId,
      owner: push.owner,
      repo: push.repo,
      queueSha: push.queueSha,
      verdict,
    });
    logOutcome(log, base, verdict.outcome, {
      headSha8: inputs.headSha.slice(0, 8),
      conclusion: verdict.conclusion,
      sourceCheckRunId: verdict.sourceCheckRunId,
      checkRunId,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    log.error(
      {
        ...base,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      },
      "merge-queue review verdict copy failed"
    );
    throw error;
  }
}

function logOutcome(
  log: Logger,
  base: Record<string, unknown>,
  outcome: QueueCopyOutcome,
  fields: Record<string, unknown>
): void {
  log.info(
    { ...base, outcome, ...fields },
    "merge-queue review verdict copied"
  );
}
