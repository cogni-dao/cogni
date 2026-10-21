// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/tools`
 * Purpose: Tool IDs + the fixed context-gathering plan for the work-prioritizer graph.
 * Scope: Constants only. Does NOT execute tools or enforce policy (the wrapper + toolRunner do).
 * Invariants:
 *   - EXACT_ALLOWLIST: the graph may use exactly these seven tools — reads plus the three EDO writes
 *     (hypothesize, decide, record_outcome). PROPOSE_ONLY: no work-item write of any kind, no knowledge_write.
 *   - BOUNDED_CONTEXT: every read is bounded (limit set) so one cycle's context is finite.
 *   - WRITE_CAP: ≤ MAX_HYPOTHESES_PER_CYCLE + MAX_OUTCOMES_PER_CYCLE + 1 decision EDO rows per cycle.
 * Side-effects: none
 * Links: story.5096, task.5282, TOOL_USE_SPEC.md
 * @public
 */

import {
  EDO_DECIDE_NAME,
  EDO_HYPOTHESIZE_NAME,
  EDO_RECORD_OUTCOME_NAME,
  GET_CURRENT_TIME_NAME,
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  WORK_ITEM_QUERY_NAME,
} from "@cogni/ai-tools";

/** The complete tool allowlist for langgraph:work-prioritizer. */
export const WORK_PRIORITIZER_TOOL_IDS = [
  WORK_ITEM_QUERY_NAME,
  KNOWLEDGE_SEARCH_NAME,
  KNOWLEDGE_READ_NAME,
  EDO_HYPOTHESIZE_NAME,
  EDO_DECIDE_NAME,
  EDO_RECORD_OUTCOME_NAME,
  GET_CURRENT_TIME_NAME,
] as const;
export type WorkPrioritizerToolId = (typeof WORK_PRIORITIZER_TOOL_IDS)[number];

/** The only state-changing tools in the allowlist (all EDO, each an atomic single commit). */
export const WORK_PRIORITIZER_WRITE_TOOL_IDS = [
  EDO_HYPOTHESIZE_NAME,
  EDO_DECIDE_NAME,
  EDO_RECORD_OUTCOME_NAME,
] as const;

/** New hypotheses per cycle (further bounded by the policy's daily cap). */
export const MAX_HYPOTHESES_PER_CYCLE = 3;
/** Due-hypothesis outcomes recorded per cycle. */
export const MAX_OUTCOMES_PER_CYCLE = 3;

/**
 * Items per judge call. Measured against gpt-oss-120b with the compact line format (v4.2): batch 8 and
 * batch 14 both returned 54/54 valid judgments over 2 replays of the candidate backlog; 14 halves calls.
 */
export const JUDGE_BATCH_SIZE = 14;

/** Snapshot pagination bound (pages of BACKLOG_QUERY.limit items). */
export const MAX_SNAPSHOT_PAGES = 40;

/** Last-resort EDO domain; the real one is derived from the run's context (guards.selectEdoDomain). */
export const PRIORITIZER_EDO_DOMAIN = "strategy";

/** Tag on every EDO row this graph files — also how the next cycle finds its own prior chain. */
export const PRIORITIZER_EDO_TAG = "work-prioritizer";

/**
 * One snapshot page: actionable + blocked statuses (never done/cancelled), tool max page size. `actor` is
 * deliberately omitted (Doltgres has no actor column).
 */
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
  readonly args: Readonly<Record<string, unknown>>;
  readonly plane: ContextPlane;
}

/**
 * Fixed hub reads, executed in order before any judgment.
 *
 * Plane classification is by READ, not by row type (the knowledge tools do not expose
 * `entry_type`): rows returned by the EDO-targeted reads (this graph's own prior chain,
 * plus strategy rows matching hypothesis/decision/goal) count as `edo`; everything else
 * as `knowledge`. An id seen by both is `edo`.
 *
 * Domains: strategy/meta/build-agents (prod hub shelves) PLUS `operator` (nodes that keep
 * goals + rules in their node-named domain, e.g. candidate-a). Every read keeps its limit,
 * so the total stays bounded (≤ 20+5+5+10+10+10+10 + 20+10+10+10+10 entries).
 */
export const CONTEXT_READS: readonly ContextRead[] = [
  {
    tool: KNOWLEDGE_READ_NAME,
    args: { domain: "strategy", limit: 20 },
    plane: "knowledge",
  },
  {
    tool: KNOWLEDGE_SEARCH_NAME,
    args: { domain: "meta", query: "priorit", limit: 5 },
    plane: "knowledge",
  },
  {
    tool: KNOWLEDGE_SEARCH_NAME,
    args: { domain: "build-agents", query: "priorit", limit: 5 },
    plane: "knowledge",
  },
  {
    tool: KNOWLEDGE_READ_NAME,
    args: { domain: "strategy", tags: [PRIORITIZER_EDO_TAG], limit: 10 },
    plane: "edo",
  },
  {
    tool: KNOWLEDGE_SEARCH_NAME,
    args: { domain: "strategy", query: "hypothes", limit: 10 },
    plane: "edo",
  },
  {
    tool: KNOWLEDGE_SEARCH_NAME,
    args: { domain: "strategy", query: "decision", limit: 10 },
    plane: "edo",
  },
  {
    tool: KNOWLEDGE_SEARCH_NAME,
    args: { domain: "strategy", query: "goal", limit: 10 },
    plane: "edo",
  },
  {
    tool: KNOWLEDGE_READ_NAME,
    args: { domain: "operator", limit: 20 },
    plane: "knowledge",
  },
  {
    tool: KNOWLEDGE_READ_NAME,
    args: { domain: "operator", tags: [PRIORITIZER_EDO_TAG], limit: 10 },
    plane: "edo",
  },
  {
    tool: KNOWLEDGE_SEARCH_NAME,
    args: { domain: "operator", query: "hypothes", limit: 10 },
    plane: "edo",
  },
  {
    tool: KNOWLEDGE_SEARCH_NAME,
    args: { domain: "operator", query: "decision", limit: 10 },
    plane: "edo",
  },
  {
    tool: KNOWLEDGE_SEARCH_NAME,
    args: { domain: "operator", query: "goal", limit: 10 },
    plane: "edo",
  },
];

/** The list reads that surface this graph's own decision chain — re-read for PRIOR_CAS. */
export const PRIOR_CHAIN_READS: readonly ContextRead[] = CONTEXT_READS.filter(
  (r) => r.tool === KNOWLEDGE_READ_NAME
);
