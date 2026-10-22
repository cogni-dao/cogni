// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/tools`
 * Purpose: Tool IDs + the fixed context-gathering plan for the work-prioritizer graph.
 * Scope: Constants only. Does NOT execute tools or enforce policy (the wrapper + toolRunner do).
 * Invariants:
 *   - EXACT_ALLOWLIST: exactly these six tools — five reads (incl. core__goal_list, the one goal reader) plus
 *     the one EDO write (decide). PROPOSE_ONLY: no work-item
 *     write of any kind, no knowledge_write.
 *   - BOUNDED_CONTEXT: every read is bounded (limit set) so one cycle's context is finite.
 *   - WRITE_CAP: ≤ 1 EDO decision per cycle; nothing else is written.
 * Side-effects: none
 * Links: story.5096, task.5282, TOOL_USE_SPEC.md
 * @public
 */

import {
  EDO_DECIDE_NAME,
  GET_CURRENT_TIME_NAME,
  GOAL_LIST_NAME,
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  WORK_ITEM_QUERY_NAME,
} from "@cogni/ai-tools";

/** The only state-changing tool in the allowlist (one atomic EDO commit). */
export const WORK_PRIORITIZER_WRITE_TOOL_IDS = [EDO_DECIDE_NAME] as const;

/** The complete tool allowlist for langgraph:work-prioritizer. */
export const WORK_PRIORITIZER_TOOL_IDS = [
  WORK_ITEM_QUERY_NAME,
  KNOWLEDGE_SEARCH_NAME,
  KNOWLEDGE_READ_NAME,
  GET_CURRENT_TIME_NAME,
  GOAL_LIST_NAME,
  ...WORK_PRIORITIZER_WRITE_TOOL_IDS,
] as const;

/** gpt-oss-120b, compact v4.2 lines: batch 8 and 14 both returned 54/54 valid judgments; 14 halves calls. */
export const JUDGE_BATCH_SIZE = 14;
export const MAX_SNAPSHOT_PAGES = 40;
/** Tag on every EDO row this graph files — also how the next cycle finds its own prior chain. */
export const PRIORITIZER_EDO_TAG = "work-prioritizer";

/** One snapshot page: actionable + blocked statuses; no `actor` (Doltgres has no actor column). */
export const BACKLOG_QUERY = {
  statuses: [
    "needs_triage",
    "needs_research",
    "needs_design",
    "needs_implement",
    "needs_closeout",
    "needs_merge",
    "blocked",
  ],
  limit: 50,
} as const;

/** Which plane a context read feeds: hub knowledge, or the EDO (hypothesis/decision) chain. */
export type ContextPlane = "knowledge" | "edo";

export interface ContextRead {
  readonly tool: typeof KNOWLEDGE_READ_NAME | typeof KNOWLEDGE_SEARCH_NAME;
  readonly args: Record<string, unknown>;
  readonly plane: ContextPlane;
}

const list = (domain: string, limit: number, tagged = false): ContextRead => ({
  tool: KNOWLEDGE_READ_NAME,
  args: { domain, limit, ...(tagged && { tags: [PRIORITIZER_EDO_TAG] }) },
  plane: tagged ? "edo" : "knowledge",
});
const search = (
  domain: string,
  query: string,
  limit: number,
  plane: ContextPlane
): ContextRead => ({
  tool: KNOWLEDGE_SEARCH_NAME,
  args: { domain, query, limit },
  plane,
});

/**
 * Fixed hub reads, in order, before any judgment. Plane is by READ (the tools expose no entry type): the
 * prioritizer's own tagged chain and the hypothesis/decision/goal searches are `edo`, the rest `knowledge`.
 * Domains: strategy/meta/build-agents (prod shelves) plus `operator` (candidate-a keeps goals there).
 */
export const CONTEXT_READS: readonly ContextRead[] = [
  list("strategy", 20),
  search("meta", "priorit", 5, "knowledge"),
  search("build-agents", "priorit", 5, "knowledge"),
  ...["strategy", "operator"].flatMap((d) => [
    ...(d === "operator" ? [list(d, 20)] : []),
    list(d, 10, true),
    search(d, "hypothes", 10, "edo"),
    search(d, "decision", 10, "edo"),
    search(d, "goal", 10, "edo"),
  ]),
];

/** The list reads that surface this graph's own decision chain — re-read for PRIOR_CAS. */
export const PRIOR_CHAIN_READS = CONTEXT_READS.filter(
  (r) => r.tool === KNOWLEDGE_READ_NAME
);
