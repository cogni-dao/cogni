// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/apply`
 * Purpose: The apply step (story.5108): patch each changed plan row's priority + rank through the existing
 *   work-item patch path (`core__work_item_transition` action=patch) with the snapshot revision as compare-and-set.
 * Scope: Pure ordering + outcome classification, and one loop over an injected tool call. Does not read env,
 *   decide whether to apply (graph.ts gates it), or authorize anything (the tool runner + capability do).
 * Invariants:
 *   - APPLY_IS_GATED: graph.ts runs this only when the run sets `configurable.apply === true`, is grant-backed
 *     (`configurable.grantId`), and filed this cycle's decision. Otherwise nothing is patched.
 *   - DEMOTIONS_FIRST: demotions, then rank-only moves, then promotions (unprioritized → a level counts as a promotion).
 *   - CAS_ALWAYS: every patch carries `expectedRevision` = the snapshot revision; a row without one is skipped.
 *   - CONFLICT_SKIPS: `revision_conflict` → counted, never retried; the next cycle re-reads the item.
 *   - P0P1_DENIAL_IS_COUNTED: an `authz_denied` patch to p0/p1 (P0P1_IS_NODE_ADMIN, #2864) is counted in
 *     `deniedP0P1`, never retried, and never fails the cycle. p0/p1 remain proposals in the filed decision.
 *   - ONE_PATCH_PER_ROW: each plan row is patched at most once per cycle.
 * Side-effects: IO only through the injected `patch` call
 * Links: graph.ts, plan.ts (buildPlan), packages/ai-tools/src/tools/work-item-transition.ts, story.5108, story.5075
 * @public
 */

import type { RunnableConfig } from "@langchain/core/runnables";

import type { DecodedToolResult } from "./context";
import type { PlanRow } from "./schema";

/** Counts of one cycle's apply step (flattened into the cycle telemetry). */
export interface ApplyOutcome {
  /** Patches that landed. */
  readonly applied: number;
  /** Lost compare-and-set (`revision_conflict`): skipped, re-read next cycle. */
  readonly conflicts: number;
  /** p0/p1 patches refused by the node-admin gate (`authz_denied`). */
  readonly deniedP0P1: number;
  /** The item ids behind `deniedP0P1` (logged with the cycle telemetry). */
  readonly deniedP0P1Ids: readonly string[];
  /** Any other refusal or error (verbatim in `errors`). */
  readonly failed: number;
  /** Rows with no snapshot revision (cannot compare-and-set). */
  readonly skipped: number;
  readonly errors: readonly string[];
}

export const emptyApply = (): ApplyOutcome => ({
  applied: 0,
  conflicts: 0,
  deniedP0P1: 0,
  deniedP0P1Ids: [],
  failed: 0,
  skipped: 0,
  errors: [],
});

/** APPLY_GATED: the run opts in (`configurable.apply === true`) and is grant-backed (a scheduled run). Env-agnostic. */
export function applyEnabled(config?: RunnableConfig): boolean {
  const c = config?.configurable as
    | { apply?: unknown; grantId?: unknown }
    | undefined;
  return (
    c?.apply === true && typeof c.grantId === "string" && c.grantId.length > 0
  );
}

/** The apply fields of the cycle telemetry (`ai.work_prioritizer.cycle`); counts are 0 when apply did not run. */
export function applyTelemetry(outcome: ApplyOutcome | null, enabled: boolean) {
  const o = outcome ?? emptyApply();
  return {
    applyEnabled: enabled,
    applied: o.applied,
    conflicts: o.conflicts,
    deniedP0P1: o.deniedP0P1,
    deniedP0P1Ids: o.deniedP0P1Ids,
    applyFailed: o.failed,
    applySkipped: o.skipped,
  };
}

/** 0 = demotion, 1 = rank-only, 2 = promotion (incl. unprioritized → a level). */
const moveClass = (r: PlanRow) =>
  r.from === null ? 2 : r.to > r.from ? 0 : r.to === r.from ? 1 : 2;

/** DEMOTIONS_FIRST — stable within each class (plan order = rank order). */
export function applyOrder(plan: readonly PlanRow[]): PlanRow[] {
  return plan
    .map((row, i) => ({ row, i }))
    .sort((a, b) => moveClass(a.row) - moveClass(b.row) || a.i - b.i)
    .map((x) => x.row);
}

/** The tool args for one row's compare-and-set patch. */
export const patchArgs = (row: PlanRow & { expectedRevision: number }) => ({
  action: "patch",
  id: row.itemId,
  priority: row.to,
  rank: row.rank,
  expectedRevision: row.expectedRevision,
});

/** Patch every changed row in DEMOTIONS_FIRST order; classify each result; never throw, never retry. */
export async function applyPlan(
  plan: readonly PlanRow[],
  patch: (args: ReturnType<typeof patchArgs>) => Promise<DecodedToolResult>
): Promise<ApplyOutcome> {
  let applied = 0;
  let conflicts = 0;
  const deniedP0P1Ids: string[] = [];
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const row of applyOrder(plan)) {
    if (row.expectedRevision === null) {
      skipped += 1;
      continue;
    }
    const r = await patch(
      patchArgs({ ...row, expectedRevision: row.expectedRevision })
    );
    const value = r.ok
      ? (r.value as { success?: unknown; code?: unknown } | null)
      : null;
    if (r.ok && value?.success === true) applied += 1;
    else if (r.ok && value?.code === "revision_conflict") conflicts += 1;
    else if (!r.ok && row.to <= 1 && r.error.includes("authz_denied"))
      deniedP0P1Ids.push(row.itemId);
    else {
      failed += 1;
      errors.push(
        `patch ${row.itemId}: ${r.ok ? JSON.stringify(r.value).slice(0, 200) : r.error}`
      );
    }
  }
  return {
    applied,
    conflicts,
    deniedP0P1: deniedP0P1Ids.length,
    deniedP0P1Ids,
    failed,
    skipped,
    errors,
  };
}
