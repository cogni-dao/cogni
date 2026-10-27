// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/evals/cogni/coverage-grader`
 * Purpose: Grade one Cogni run for SYSTEMATIC KNOWLEDGE GATHERING over its trace.
 * Scope: Pure function over tool-call events + the final proposal; does NOT read Langfuse,
 *   call tools, run the graph, or enforce anything inside the graph. The caller supplies the
 *   trace (from node-ai-traces-read or the run's tool messages).
 * Invariants:
 *   - METRIC_IS_COVERAGE: coverage = read planes exercised with a full-body read ÷ 5.
 *   - GROUNDING_GATE: every cited sourceId must have a full-body read in the trace.
 *   - MISSING_EVIDENCE_IS_UNSCORABLE: never a silent pass; an errored/empty run is unscorable.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/bug.5542 · https://cognidao.org/knowledge/agent-evaluation-loop
 * @public
 */

/** One tool call observed in a run's trace. */
export type ToolEvent = {
  /** Tool id, e.g. "core__work_item_read". */
  readonly name: string;
  /** True when the call returned a usable (non-error) result. */
  readonly ok: boolean;
  /**
   * True when the result is a FULL BODY read (not a list/search row). For item/entry/code
   * reads this is the complete record; a query/search/list hit is never a full body.
   */
  readonly fullBody?: boolean;
  /** The canonical id the read resolves (work/knowledge/code id), for grounding. */
  readonly id?: string;
};

export type GradedProposal = {
  readonly status?: string;
  readonly items?: ReadonlyArray<{ readonly sourceIds?: readonly string[] }>;
};

export type CoverageGrade = {
  readonly grade: "pass" | "fail" | "unscorable";
  readonly coverage: number;
  readonly grounding: number;
  readonly planesHit: readonly string[];
  readonly planesMissed: readonly string[];
  readonly citedUnread: readonly string[];
  readonly reason?: string;
};

/** The five read planes a systematic gather must cover, each needing a successful full read. */
const PLANES: Record<string, (e: ToolEvent) => boolean> = {
  goals: (e) => e.name === "core__goal_list" && e.ok,
  knowledge: (e) =>
    e.name === "core__knowledge_read" && e.ok && e.fullBody === true,
  inbox: (e) => e.name === "core__knowledge_contribution_read" && e.ok,
  work: (e) => e.name === "core__work_item_read" && e.ok && e.fullBody === true,
  git: (e) => e.name === "core__node_code_read" && e.ok && e.fullBody === true,
};

const FULL_READ_TOOLS = new Set([
  "core__work_item_read",
  "core__knowledge_read",
  "core__node_code_read",
]);

/**
 * Grade a run for systematic knowledge gathering.
 *
 * Pass requires BOTH: coverage 1.0 (every plane full-read) AND grounding 1.0 (every cited
 * source was full-read in the trace). A successful tool name is not coverage; a list/search
 * hit is not a full body; a citation without a matching full read is not grounded.
 */
export function gradeCoverage(
  events: readonly ToolEvent[],
  proposal: GradedProposal | null | undefined
): CoverageGrade {
  const base = {
    coverage: 0,
    grounding: 0,
    planesHit: [] as string[],
    planesMissed: Object.keys(PLANES),
    citedUnread: [] as string[],
  };
  if (!Array.isArray(events) || events.length === 0)
    return { ...base, grade: "unscorable", reason: "no_tool_events" };
  if (!proposal || proposal.status === "incomplete")
    return {
      ...base,
      grade: "unscorable",
      reason:
        proposal?.status === "incomplete" ? "run_incomplete" : "no_proposal",
    };

  const planesHit = Object.entries(PLANES)
    .filter(([, matches]) => events.some(matches))
    .map(([plane]) => plane);
  const planesMissed = Object.keys(PLANES).filter(
    (p) => !planesHit.includes(p)
  );
  const coverage = planesHit.length / Object.keys(PLANES).length;

  const fullReadIds = new Set(
    events
      .filter(
        (e) =>
          e.ok && e.fullBody === true && FULL_READ_TOOLS.has(e.name) && e.id
      )
      .map((e) => e.id as string)
  );
  const cited = [
    ...new Set(
      (proposal.items ?? []).flatMap((item) => [...(item.sourceIds ?? [])])
    ),
  ];
  const citedUnread = cited.filter((id) => !fullReadIds.has(id));
  const grounding = cited.length
    ? (cited.length - citedUnread.length) / cited.length
    : 1;

  const grade = coverage === 1 && grounding === 1 ? "pass" : "fail";
  return { grade, coverage, grounding, planesHit, planesMissed, citedUnread };
}
