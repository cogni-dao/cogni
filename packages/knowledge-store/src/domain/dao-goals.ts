// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/dao-goals`
 * Purpose: Selects the approved DAO goals every AI loop reads, and names the goal rows a contribution changes.
 * Scope: Pure selection + shape (which rows count as goals). Does not perform I/O; the SQL read lives in the Doltgres adapter's `listActiveGoals`.
 * Invariants:
 *   - ONE_GOAL_LIST: a goal is a merged row with `entry_type = 'goal'` whose id
 *     starts `goal-`, not deprecated. A goal is a human commitment, not a
 *     `hypothesis`: it is admin-merged and its confidence is never recomputed
 *     from citations. No new table — `entry_type` is plain text.
 *   - NO_GOAL_CAP (dao-goals-design): every active goal is returned. There is no
 *     maximum and the list is never truncated.
 *   - GOAL_CHANGE_IS_NODE_ADMIN: `touchedGoalIds` names every `goal-*` row a
 *     contribution changes, plus any citation leaving one, from the RAW row ids.
 *     A citation INTO a goal is not a goal change.
 *   - NO_GOALS_FAILS_LOUD: zero goals is an empty array the caller must render
 *     visibly (the cognition bundle prints `no approved goals`).
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/dao-goals-design
 * @public
 */

/** The entry type of a DAO goal atom. */
export const GOAL_ENTRY_TYPE = "goal" as const;
/** Id prefix every DAO goal atom carries (`goal-<slug>`). */
export const GOAL_ID_PREFIX = "goal-" as const;

/** One approved DAO goal, as every reader sees it. */
export interface ActiveGoal {
  id: string;
  title: string;
  content: string;
  /** The goal's `By:` deadline (`evaluate_at`), when set. */
  evaluateAt: Date | null;
}

/** The row fields goal selection needs; both adapters project to this. */
export interface GoalCandidateRow {
  id: string;
  entryType: string | null | undefined;
  status?: string | null | undefined;
  title: string;
  content: string;
  evaluateAt: Date | null;
}

/** True iff the row is an active DAO goal atom (ONE_GOAL_LIST). */
export function isActiveGoalRow(row: GoalCandidateRow): boolean {
  return (
    row.entryType === GOAL_ENTRY_TYPE &&
    row.id.startsWith(GOAL_ID_PREFIX) &&
    row.status !== "deprecated"
  );
}

/** Filter candidate rows to the active goal list, sorted by id (NO_GOAL_CAP). */
export function selectActiveGoals(
  rows: readonly GoalCandidateRow[]
): ActiveGoal[] {
  return rows
    .filter(isActiveGoalRow)
    .map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      evaluateAt: r.evaluateAt,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A hub row id in the goal namespace (`goal-*`). */
export function isGoalRowId(rowId: unknown): rowId is string {
  return typeof rowId === "string" && rowId.startsWith(GOAL_ID_PREFIX);
}

/** The raw row ids a contribution changes, as `touchedGoalIds` reads them. */
export interface GoalTouchInput {
  /** Every knowledge row id on either side of the raw diff. */
  readonly knowledgeIds: readonly string[];
  /** Every citing id on either side of the raw citations diff. */
  readonly citingIds: readonly string[];
}

/**
 * The goal rows a contribution changes (GOAL_CHANGE_IS_NODE_ADMIN): any changed
 * `goal-*` knowledge row, and any citation edge whose citing side is one.
 * Sorted and deduped. Empty means the merge needs no goal authority.
 */
export function touchedGoalIds(changes: GoalTouchInput): string[] {
  const ids = new Set<string>();
  for (const id of [...changes.knowledgeIds, ...changes.citingIds]) {
    if (isGoalRowId(id)) ids.add(id);
  }
  return [...ids].sort();
}
