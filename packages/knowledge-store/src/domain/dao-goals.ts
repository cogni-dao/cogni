// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/dao-goals`
 * Purpose: The DAO goal list — the at-most-three approved goals every AI loop
 *   (cognition bundle, prioritizer, brain steward) reads through one reader.
 * Scope: Pure selection + shape. The SQL read lives in the Doltgres adapter's
 *   `listActiveGoals`; this module owns which rows count and the cap.
 * Invariants:
 *   - ONE_GOAL_LIST: a goal is a merged `hypothesis` row in domain `strategy`
 *     whose id starts `goal-`, not deprecated. No new entry type, no new table.
 *   - MAX_THREE_GOALS: more than 3 active goals throws `TooManyActiveGoalsError`;
 *     the list is never silently truncated.
 *   - NO_GOALS_FAILS_LOUD: zero goals is an empty array the caller must render
 *     visibly (the cognition bundle prints `no approved goals`).
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/dao-goals-design, docs/design/knowledge-goal-loop.md
 * @public
 */

import { TooManyActiveGoalsError } from "../port/knowledge-store.port.js";

/** Id prefix that marks a hypothesis as a DAO goal atom (`goal-<slug>`). */
export const GOAL_ID_PREFIX = "goal-" as const;
/** The one domain DAO goal atoms live in. */
export const GOAL_DOMAIN = "strategy" as const;
/** MAX_THREE_GOALS. */
export const MAX_ACTIVE_GOALS = 3 as const;

/** One approved DAO goal, as every reader sees it. */
export interface ActiveGoal {
  id: string;
  title: string;
  content: string;
  /** The goal's `By:` date (the hypothesis `evaluate_at`). */
  evaluateAt: Date | null;
}

/** The row fields goal selection needs; both adapters project to this. */
export interface GoalCandidateRow {
  id: string;
  domain: string;
  entryType: string | null | undefined;
  status?: string | null | undefined;
  title: string;
  content: string;
  evaluateAt: Date | null;
}

/** True iff the row is an active DAO goal atom (ONE_GOAL_LIST). */
export function isActiveGoalRow(row: GoalCandidateRow): boolean {
  return (
    row.entryType === "hypothesis" &&
    row.domain === GOAL_DOMAIN &&
    row.id.startsWith(GOAL_ID_PREFIX) &&
    row.status !== "deprecated"
  );
}

/**
 * Filter candidate rows to the active goal list, sorted by id, and enforce
 * MAX_THREE_GOALS. Throws rather than truncates.
 */
export function selectActiveGoals(
  rows: readonly GoalCandidateRow[]
): ActiveGoal[] {
  const goals = rows
    .filter(isActiveGoalRow)
    .map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      evaluateAt: r.evaluateAt,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (goals.length > MAX_ACTIVE_GOALS) {
    throw new TooManyActiveGoalsError(
      goals.map((g) => g.id),
      MAX_ACTIVE_GOALS
    );
  }
  return goals;
}
