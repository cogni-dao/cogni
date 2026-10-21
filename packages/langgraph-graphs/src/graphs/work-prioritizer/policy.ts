// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/policy`
 * Purpose: Work-prioritization policy contract (design v4 §1) as the graph receives it, plus the full-review request.
 * Scope: Zod schema + parsing of the policy (and `fullReview`) from the run's trigger message; does not read env or repo-spec.
 * Invariants:
 *   - POLICY_FROM_TRIGGER: the governance schedule appends the repo-spec policy to the trigger message as a
 *     fenced json block `{ "workPrioritization": … }`; the graph never reads env or files.
 *   - POLICY_REQUIRED: no valid policy in the trigger ⇒ the cycle ends `no_policy`.
 *   - GOALS_NOT_POLICY: goals come from the hub (listActiveGoals), never from the policy; there are no caps.
 *   - FULL_REVIEW_ON_REQUEST: `"fullReview": true` beside the policy in that block forces a whole-backlog review.
 *   - PROPOSE_ONLY: the graph writes no work item; an `applyMode` the schedule still sends is ignored.
 * Side-effects: none
 * Links: packages/repo-spec (work_prioritization), packages/scheduler-core governanceGraphMessage
 * @public
 */

import { z } from "zod";

export const WorkPrioritizationPolicySchema = z.object({
  policyVersion: z.string().min(1),
});
export type WorkPrioritizationPolicy = z.infer<
  typeof WorkPrioritizationPolicySchema
>;

/** Parse `{ "workPrioritization": …, "fullReview"?: true }` from the last fenced json block of the trigger text. */
export function policyFromTrigger(text: string): {
  policy: WorkPrioritizationPolicy | null;
  fullReview: boolean;
} {
  const last = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
  let raw: { workPrioritization?: unknown; fullReview?: unknown } = {};
  try {
    raw = (last ? JSON.parse(last) : null) ?? {};
  } catch {
    // no policy
  }
  const parsed = WorkPrioritizationPolicySchema.safeParse(
    raw.workPrioritization
  );
  return {
    policy: parsed.success ? parsed.data : null,
    fullReview: raw.fullReview === true,
  };
}
