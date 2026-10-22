// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/trigger`
 * Purpose: Reads the one option a run's trigger message may carry: an on-demand full review.
 * Scope: Parses the last fenced json block of the trigger text; does not read env, repo-spec, or any policy.
 * Invariants:
 *   - NO_POLICY: the graph takes no policy; goals come only from core__goal_list, there are no caps, and
 *     every cycle is propose-only.
 *   - FULL_REVIEW_ON_REQUEST: `{ "fullReview": true }` forces a whole-backlog review (eval + admin use);
 *     anything else, or no block, is a normal cycle.
 * Side-effects: none
 * Links: graph.ts, plan.ts (selectJudgeSet)
 * @public
 */

/** Parse `{ "fullReview"?: true }` from the last fenced json block of the trigger text. */
export function fullReviewFromTrigger(text: string): boolean {
  const last = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
  try {
    return (
      (JSON.parse(last ?? "null") as { fullReview?: unknown } | null)
        ?.fullReview === true
    );
  } catch {
    return false;
  }
}
