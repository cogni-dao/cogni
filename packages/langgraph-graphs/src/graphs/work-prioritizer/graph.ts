// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/graph`
 * Purpose: Work prioritizer AI workflow (design v4, PROPOSE mode): snapshot → judge (LLM enums) → rank (code) → EDO.
 * Scope: Pure graph factory; does not read env, hardcode a model, write any work item, or touch a database directly.
 * Invariants: FIXED_ORDER (all reads before the model; only the PRIOR_CAS re-read after; EDO writes last);
 *   COMPLETE_SNAPSHOT_OR_ABORT; DAILY_FULL_REVIEW + DELTA_SCOPE (plan.selectJudgeSet); DETERMINISTIC_TOOL_CALLS
 *   (code names every allowlisted tool and its args); PROPOSE_ONLY (the plan — id, revision, priority, rank —
 *   is filed in an EDO decision, never applied); DECISION_ON_CHANGE (a delta cycle with an unchanged table files
 *   nothing; a full review always files, recording `reviewedAt`); PRIOR_CAS (a newer decision than the prior ⇒
 *   `stale_prior`, zero writes); REPORT_ON_STREAM (telemetry as one `<prioritizer_report>` text delta).
 * Side-effects: none
 * Links: .context/prioritizer-design-v4.md, rank.ts, plan.ts, prompts.ts, story.5096
 * @public
 */

import {
  EDO_DECIDE_NAME,
  GET_CURRENT_TIME_NAME,
  GOAL_LIST_NAME,
  WORK_ITEM_QUERY_NAME,
} from "@cogni/ai-tools";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  Annotation,
  MessagesAnnotation,
  StateGraph,
} from "@langchain/langgraph";

import {
  getCogniExecContext,
  hasCogniExecContext,
} from "../../runtime/cogni/exec-context";
import type { CreateReactAgentGraphOptions } from "../types";
import * as C from "./context";
import * as G from "./guards";
import * as P from "./plan";
import { policyFromTrigger, type WorkPrioritizationPolicy } from "./policy";
import {
  buildJudgeUserMessage,
  type JudgeSample,
  judgeItems,
  WORK_PRIORITIZER_GRAPH_NAME,
  WORK_PRIORITIZER_PROMPT_VERSION,
  WORK_PRIORITIZER_SYSTEM_PROMPT,
} from "./prompts";
import { rankItems } from "./rank";
import {
  DECISION_SCHEMA_VERSION,
  type DecisionPayload,
  RANK_HEURISTIC,
  type RankedRow,
} from "./schema";
import * as T from "./tools";

export { WORK_PRIORITIZER_GRAPH_NAME };

/** Delimiters of the cycle report pushed onto the run stream (REPORT_ON_STREAM). */
export const PRIORITIZER_REPORT_OPEN = "<prioritizer_report>";
export const PRIORITIZER_REPORT_CLOSE = "</prioritizer_report>";

/** Flat cycle summary — no free text, no item content; safe to log. */
export type PrioritizerCycleTelemetry = ReturnType<typeof telemetryOf>;

/** Telemetry, the filed payload, and tool errors / unusable judge lines verbatim. */
export interface PrioritizerRunReport {
  readonly telemetry: PrioritizerCycleTelemetry;
  readonly payload: DecisionPayload | null;
  readonly errors: readonly string[];
  /** First raw judge lines per batch + parse counts (logged as ai.work_prioritizer.judge_sample). */
  readonly judgeSamples: readonly JudgeSample[];
}

const emptyEdo = () => ({
  decisionId: null as string | null,
  newerDecisionId: null as string | null,
  writes: 0,
  errors: [] as string[],
});

const replace = <V>(defaultValue: () => V) =>
  Annotation<V>({ reducer: (_left, right) => right, default: defaultValue });

const WorkPrioritizerState = Annotation.Root({
  ...MessagesAnnotation.spec,
  policy: replace<WorkPrioritizationPolicy | null>(() => null),
  /** ONE_GOAL_LIST: core__goal_list this cycle (null = not read); a read failure or >3 is goalsError. */
  goals: replace<readonly C.ActiveGoal[] | null>(() => null),
  goalsError: replace<string | null>(() => null),
  fullReviewRequested: replace<boolean>(() => false),
  /** Null until the snapshot is complete (COMPLETE_SNAPSHOT_OR_ABORT). */
  context: replace<C.GatheredContext | null>(() => null),
  toolErrors: replace<string[]>(() => []),
  prior: replace<P.PriorDecision | null>(() => null),
  judged: replace<Awaited<ReturnType<typeof judgeAndRank>> | null>(() => null),
  payload: replace<DecisionPayload | null>(() => null),
  edo: replace<ReturnType<typeof emptyEdo> | null>(() => null),
  structuredResponse: replace<PrioritizerRunReport | undefined>(
    () => undefined
  ),
});
type S = typeof WorkPrioritizerState.State;
type Llm = {
  invoke: (m: BaseMessage[], c?: RunnableConfig) => Promise<unknown>;
};

const ALLOWED: ReadonlySet<string> = new Set(T.WORK_PRIORITIZER_TOOL_IDS);

const messageText = (m: unknown): string => {
  const c = typeof m === "string" ? m : (m as { content?: unknown })?.content;
  return Array.isArray(c)
    ? c.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("")
    : String(c ?? "");
};

const levelCountsOf = (rows: readonly RankedRow[]) =>
  [0, 1, 2, 3, 4].map((l) => rows.filter((r) => r.to === l).length);

/** Judge (model, delta-scoped) then rank + plan (code) over the whole snapshot. */
async function judgeAndRank(
  ctx: C.GatheredContext,
  policyVersion: string,
  goals: readonly C.ActiveGoal[],
  prior: P.PriorDecision | null,
  trigger: { readonly text: string; readonly fullReview: boolean },
  llm: Llm,
  config: RunnableConfig
) {
  const items = [...ctx.workItems].sort((a, b) => (a.id < b.id ? -1 : 1));
  const select = P.selectJudgeSet(items, prior, {
    now: ctx.now,
    promptVersion: WORK_PRIORITIZER_PROMPT_VERSION,
    goals: goals.map((g) => g.id),
    requested: trigger.fullReview,
    hubEntries: ctx.entries,
  });
  const fresh = await judgeItems(
    select.toJudge,
    T.JUDGE_BATCH_SIZE,
    async (batch) => {
      const messages = [
        new SystemMessage(WORK_PRIORITIZER_SYSTEM_PROMPT),
        new HumanMessage(
          buildJudgeUserMessage({
            ctx,
            goals,
            policyVersion,
            batch,
            triggerMessage: trigger.text,
          })
        ),
      ];
      // NO_TOOLS_AT_JUDGE: plain invoke (no bindTools); TRANSPORT_RETRY_ONCE on a stream drop.
      const reply = await llm
        .invoke(messages, config)
        .catch(() => llm.invoke(messages, config));
      return messageText(reply);
    }
  );
  const judgments = new Map([...select.carried, ...fresh.judgments]);
  const table = prior?.table ?? null;
  const rows = rankItems({
    items: ctx.workItems,
    judgments,
    goals: goals.map((g) => g.id),
    // Evidence is admissible if fetched this cycle, or by the cycle whose judgment is carried.
    knownEvidenceIds: new Set([
      ...ctx.workItems.map((i) => i.id),
      ...ctx.entries.map((e) => e.id),
      ...(prior?.consumedIds ?? []),
    ]),
    duplicateGroups: ctx.duplicateCandidates,
    blockerCycleMembers: new Set(ctx.blockerCycles.flat()),
  });
  const plan = P.buildPlan(rows);
  const diff = P.diffVsPrior(rows, table);
  return {
    ...select,
    judgments,
    reused: select.carried.size,
    fresh,
    rows,
    plan,
    diff,
    // DECISION_ON_CHANGE: a full review always files (its decision records reviewedAt).
    noChange:
      select.scope === "delta" && P.isNoChange(plan, diff, table !== null),
  };
}

/**
 * Create the work-prioritizer graph: START → snapshot → (judge → emit_edo →) finalize → END; a cycle with no
 * policy, no (or >3) active goals, an incomplete or empty snapshot, or no hub context goes straight to finalize
 * and files nothing. TYPE_TRANSPARENT_RETURN.
 */
export function createWorkPrioritizerGraph(opts: CreateReactAgentGraphOptions) {
  const toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
  /** DETERMINISTIC_TOOL_CALLS: code names the tool; anything off the allowlist is a programming error. */
  async function callTool(
    name: string,
    args: Record<string, unknown>,
    config: RunnableConfig
  ): Promise<C.DecodedToolResult> {
    if (!ALLOWED.has(name)) throw new Error(`tool '${name}' not allowlisted`);
    const tool = toolsByName.get(name);
    if (!tool) return { ok: false, error: `tool_unavailable: ${name}` };
    try {
      return C.decodeToolResult(await tool.invoke(args, config));
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  async function snapshot(state: S, config: RunnableConfig) {
    const { policy, fullReview } = policyFromTrigger(
      messageText(state.messages.at(-1))
    );
    const toolErrors: string[] = [];
    const read = async (tool: string, args: Record<string, unknown>) => {
      const r = await callTool(tool, args, config);
      if (!r.ok) toolErrors.push(`${tool}: ${r.error}`);
      return r.ok ? r.value : undefined;
    };
    if (!policy) return {};
    // ONE_GOAL_LIST: the goals come only from core__goal_list (the store's listActiveGoals). None ⇒ no_goals;
    // unreadable or >3 (too_many_active_goals) ⇒ goals_error. Either way nothing is judged or filed.
    const listed = await callTool(GOAL_LIST_NAME, {}, config);
    if (!listed.ok)
      return { policy, goalsError: `${GOAL_LIST_NAME}: ${listed.error}` };
    const goals = C.parseGoals(listed.value);
    if (goals.length === 0) return { policy, goals };
    const time = await read(GET_CURRENT_TIME_NAME, {});

    // COMPLETE_SNAPSHOT_OR_ABORT: paginate every actionable item.
    const workItems: C.FetchedWorkItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < T.MAX_SNAPSHOT_PAGES; page++) {
      const value = (await read(WORK_ITEM_QUERY_NAME, {
        ...T.BACKLOG_QUERY,
        ...(cursor ? { cursor } : {}),
      })) as { nextCursor?: string } | undefined;
      if (!value) return { policy, goals, toolErrors };
      workItems.push(...C.parseWorkItems(value));
      cursor = value.nextCursor;
      if (!cursor) break;
    }
    if (cursor) return { policy, goals, toolErrors };

    // Hub context: the goals (admissible evidence) + the fixed reads.
    const entries: C.FetchedEntry[] = goals.map((g) => ({
      ...g,
      domain: "strategy",
      confidencePct: null,
      tags: [],
      plane: "edo" as const,
    }));
    for (const r of T.CONTEXT_READS) {
      entries.push(...C.parseEntries(await read(r.tool, r.args), r.plane));
    }

    const t = Date.parse((time as { currentTime?: string })?.currentTime ?? "");
    const now = new Date(Number.isNaN(t) ? Date.now() : t).toISOString();
    const context = C.buildGatheredContext({ now, workItems, entries });
    return {
      policy,
      goals,
      fullReviewRequested: fullReview,
      context,
      toolErrors,
      prior: P.newestPriorDecision(context.entries),
    };
  }

  async function emitEdo(state: S, config: RunnableConfig) {
    const ctx = state.context as C.GatheredContext;
    const p = state.policy as WorkPrioritizationPolicy;
    const j = state.judged as Awaited<ReturnType<typeof judgeAndRank>>;
    const goalIds = (state.goals ?? []).map((g) => g.id);
    const stamp = ctx.now.slice(0, 16).replace(/[-:]/g, "").replace("T", "t");
    const cycleId = `${T.PRIORITIZER_EDO_TAG}-${stamp}`;
    const edo = emptyEdo();
    const call = async (tool: string, args: Record<string, unknown>) => {
      const r = await callTool(tool, args, config);
      if (!r.ok) edo.errors.push(`${tool}: ${r.error}`);
      return r;
    };

    // 0. PRIOR_CAS — a newer decision than our prior, or an unreadable chain, means no writes at all.
    const chain: string[] = [];
    for (const r of T.PRIOR_CHAIN_READS) {
      const res = await call(r.tool, r.args);
      if (!res.ok) return { edo };
      chain.push(...C.parseEntries(res.value, r.plane).map((e) => e.id));
    }
    const newest = chain
      .filter((id) => P.DECISION_ID_RE.test(id))
      .sort()
      .at(-1);
    const priorId = state.prior?.id;
    if (newest && (!priorId || newest > priorId)) {
      edo.newerDecisionId = newest;
      return { edo };
    }

    if (j.noChange) return { edo };

    // The decision — the proposal list for the node admin, derived from the lead active goal.
    const payload: DecisionPayload = {
      schemaVersion: DECISION_SCHEMA_VERSION,
      status: "planned",
      mode: "propose",
      scope: j.scope,
      reviewedAt:
        j.scope === "full" ? ctx.now : (state.prior?.reviewedAt ?? ctx.now),
      delta: j.delta,
      heuristic: RANK_HEURISTIC,
      policyVersion: p.policyVersion,
      promptVersion: WORK_PRIORITIZER_PROMPT_VERSION,
      modelRef: modelRefOf(config),
      cycleId,
      snapshotId: ctx.snapshotId,
      priorDecisionId: priorId ?? null,
      goals: goalIds,
      plan: j.plan,
      table: j.rows,
      diffVsPrior: j.diff,
      contextConsumed: ctx.contextConsumed,
      judgments: ctx.workItems.flatMap((i) => {
        const judgment = j.judgments.get(i.id);
        return judgment
          ? [{ itemId: i.id, revision: i.revision, judgment }]
          : [];
      }),
      unjudged: j.fresh.unjudged,
    };
    const p0 = j.rows.filter((r) => r.to === 0).map((r) => r.itemId);
    const counts = levelCountsOf(j.rows).map((n, l) => `p${l} ${n}`);
    const summary =
      `Proposed priorities (${RANK_HEURISTIC}, policy ${p.policyVersion}, ${j.scope} review): ` +
      `${counts.join(" · ")}; ${j.plan.length} changes; snapshot ${ctx.snapshotId}; ` +
      `prior ${priorId ?? "none"}.`;
    const id = `${cycleId}-decision`;
    edo.writes += 1;
    const filed = await call(EDO_DECIDE_NAME, {
      id,
      domain: G.selectEdoDomain(goalIds, ctx.entries),
      sourceType: "agent",
      sourceRef: `langgraph:${WORK_PRIORITIZER_GRAPH_NAME}`,
      tags: [T.PRIORITIZER_EDO_TAG, "prioritization", "propose"],
      title: `Priority plan ${stamp}: p0 ${p0.join(", ") || "none"}`,
      content: `${summary}\n\nPropose mode: nothing below is applied.\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
      derivesFromHypothesisId: goalIds[0],
    });
    if (filed.ok) edo.decisionId = id;
    return { edo, payload };
  }

  function finalize(state: S, config: RunnableConfig) {
    const telemetry = telemetryOf(state, modelRefOf(config));
    // REPORT_ON_STREAM: the graph's own outcome, readable by any stream consumer.
    if (hasCogniExecContext()) {
      getCogniExecContext().tokenSink.push({
        type: "text_delta",
        delta: `\n${PRIORITIZER_REPORT_OPEN}${JSON.stringify(telemetry)}${PRIORITIZER_REPORT_CLOSE}\n`,
      });
    }
    const { toolErrors, judged, edo } = state;
    const errors = [
      toolErrors,
      judged?.fresh.errors ?? [],
      edo?.errors ?? [],
    ].flat();
    return {
      structuredResponse: {
        telemetry,
        payload: state.payload,
        errors,
        judgeSamples: judged?.fresh.samples ?? [],
      },
      messages: [new AIMessage(JSON.stringify(telemetry))],
    };
  }

  const llm = opts.llm as unknown as Llm;
  return new StateGraph(WorkPrioritizerState)
    .addNode("snapshot", snapshot)
    .addNode("judge", async (state: S, config: RunnableConfig) => ({
      judged: await judgeAndRank(
        state.context as C.GatheredContext,
        (state.policy as WorkPrioritizationPolicy).policyVersion,
        state.goals ?? [],
        state.prior,
        {
          text: messageText(state.messages.at(-1)),
          fullReview: state.fullReviewRequested,
        },
        llm,
        config
      ),
    }))
    .addNode("emit_edo", emitEdo)
    .addNode("finalize", finalize)
    .addEdge("__start__", "snapshot")
    .addConditionalEdges(
      "snapshot",
      (s: S) =>
        s.context?.workItems.length &&
        G.hasHubContext(s.context.contextConsumed)
          ? "judge"
          : "finalize",
      ["judge", "finalize"]
    )
    .addEdge("judge", "emit_edo")
    .addEdge("emit_edo", "finalize")
    .addEdge("finalize", "__end__")
    .compile();
}

const modelRefOf = (c?: RunnableConfig) =>
  (c?.configurable as { model?: string } | undefined)?.model ?? null;

/** The cycle's flat telemetry (status + counts) from its final state. */
function telemetryOf(state: S, modelRef: string | null) {
  const { context: ctx, judged: j } = state;
  const edo = state.edo ?? emptyEdo();
  const status = !state.policy
    ? "no_policy"
    : state.goalsError
      ? "goals_error"
      : state.goals?.length === 0
        ? "no_goals"
        : !ctx
          ? "incomplete_snapshot"
          : ctx.workItems.length === 0
            ? "no_backlog"
            : !G.hasHubContext(ctx.contextConsumed)
              ? "rejected_context"
              : edo.newerDecisionId
                ? "stale_prior"
                : j?.noChange
                  ? "no_change"
                  : edo.decisionId
                    ? "planned"
                    : "decision_failed";
  return {
    status,
    /** The goal ids the cycle ranked against (core__goal_list); the eval checks they are all `goal-*`. */
    goalIds: (state.goals ?? []).map((g) => g.id),
    goalsError: state.goalsError,
    scope: j?.scope ?? null,
    deltaSize: j?.delta.length ?? 0,
    snapshotId: ctx?.snapshotId ?? null,
    itemsInSnapshot: ctx?.workItems.length ?? 0,
    judgedByModel: j?.fresh.judgments.size ?? 0,
    judgmentsReused: j?.reused ?? 0,
    unjudgedCount: j?.fresh.unjudged.length ?? 0,
    planRows: j?.plan.length ?? 0,
    levelCounts: levelCountsOf(j?.rows ?? []),
    decisionId: edo.decisionId,
    newerDecisionId: edo.newerDecisionId,
    edoWrites: edo.writes,
    toolErrorCount: state.toolErrors.length + edo.errors.length,
    policyVersion: state.policy?.policyVersion ?? null,
    promptVersion: WORK_PRIORITIZER_PROMPT_VERSION,
    modelRef,
  };
}
