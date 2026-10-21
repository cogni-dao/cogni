// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/graph`
 * Purpose: Work prioritizer AI workflow (design v4, PROPOSE mode): snapshot → judge (LLM enums) → rank (code) → plan → EDO.
 * Scope: Pure graph factory; does not read env, hardcode a model, write any work item, or touch a database directly.
 * Invariants:
 *   - FIXED_ORDER: snapshot → judge → rank_plan → emit_edo → finalize; all context reads precede the model (only
 *     the PRIOR_CAS re-read follows it); EDO writes happen only after ranking and guards.
 *   - COMPLETE_SNAPSHOT_OR_ABORT: every actionable item is paginated in; an incomplete fetch ends the cycle.
 *   - DAILY_FULL_REVIEW / DELTA_SCOPE: plan.selectJudgeSet picks what the model (re)judges; the rest carry.
 *   - UNJUDGED_IS_EXPLICIT: dropped items are re-asked alone (≤2 tries); still missing ⇒ p3, listed, never planned.
 *   - DETERMINISTIC_TOOL_CALLS: code names every tool (allowlist) with code-built args; the model never selects one.
 *   - PROPOSE_ONLY: the plan (id, revision, priority, rank per changed row) is filed in an EDO decision, never applied.
 *   - DECISION_ON_CHANGE: a delta cycle whose table equals its prior's files nothing; a full review always files
 *     (that decision records `reviewedAt`, which keeps full reviews daily unless requested).
 *   - PRIOR_CAS: before its first write a cycle re-reads the chain; a newer decision ⇒ `stale_prior`, zero writes.
 *   - REPORT_ON_STREAM: finalize pushes the telemetry as one `<prioritizer_report>…</prioritizer_report>` delta.
 *   - PURE_FACTORY / TYPE_TRANSPARENT_RETURN: no side effects at construction; no explicit return type.
 * Side-effects: none
 * Links: .context/prioritizer-design-v4.md, rank.ts, plan.ts, guards.ts, policy.ts, story.5096
 * @public
 */

import {
  EDO_DECIDE_NAME,
  EDO_HYPOTHESIZE_NAME,
  EDO_RECORD_OUTCOME_NAME,
  GET_CURRENT_TIME_NAME,
  KNOWLEDGE_READ_NAME,
  WORK_ITEM_QUERY_NAME,
} from "@cogni/ai-tools";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
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
  judgeItems,
  WORK_PRIORITIZER_GRAPH_NAME,
  WORK_PRIORITIZER_PROMPT_VERSION,
  WORK_PRIORITIZER_SYSTEM_PROMPT,
} from "./prompts";
import { type Overflow, rankItems } from "./rank";
import {
  DECISION_SCHEMA_VERSION,
  type DecisionPayload,
  type DueCheck,
  type HypothesisProposal,
  type ItemJudgment,
  type PlanRow,
  RANK_HEURISTIC,
  type RankedRow,
} from "./schema";
import * as T from "./tools";

export { WORK_PRIORITIZER_GRAPH_NAME };

/** Delimiters of the cycle report pushed onto the run stream (REPORT_ON_STREAM). */
export const PRIORITIZER_REPORT_OPEN = "<prioritizer_report>";
export const PRIORITIZER_REPORT_CLOSE = "</prioritizer_report>";

export type PrioritizerCycleStatus =
  | "planned"
  | "no_change"
  | "stale_prior"
  | "incomplete_snapshot"
  | "no_policy"
  | "rejected_context"
  | "no_backlog"
  | "decision_failed";

/** Flat cycle summary — no free text, no item content; safe to log. */
export type PrioritizerCycleTelemetry = ReturnType<typeof telemetryOf>;

export interface PrioritizerRunReport {
  readonly telemetry: PrioritizerCycleTelemetry;
  readonly payload: DecisionPayload | null;
  readonly guardViolations: readonly G.GuardViolation[];
  readonly toolErrors: readonly C.ToolCallError[];
  readonly judgeErrors: readonly string[];
}

const emptyEdo = () => ({
  hypothesisIds: [] as string[],
  outcomeIds: [] as string[],
  decisionId: null as string | null,
  writes: 0,
  errors: [] as C.ToolCallError[],
});

const replace = <V>(defaultValue: () => V) =>
  Annotation<V>({ reducer: (_left, right) => right, default: defaultValue });

const WorkPrioritizerState = Annotation.Root({
  ...MessagesAnnotation.spec,
  context: replace<C.GatheredContext | null>(() => null),
  snapshotComplete: replace<boolean>(() => false),
  policy: replace<WorkPrioritizationPolicy | null>(() => null),
  fullReviewRequested: replace<boolean>(() => false),
  prior: replace<P.PriorDecision | null>(() => null),
  /** item id → status, for due-hypothesis predicates (incl. items outside the snapshot). */
  observedStatus: replace<Record<string, string>>(() => ({})),
  scope: replace<P.ReviewScope | null>(() => null),
  delta: replace<string[]>(() => []),
  judgments: replace<Record<string, ItemJudgment>>(() => ({})),
  judgmentsReused: replace<number>(() => 0),
  unjudged: replace<string[]>(() => []),
  proposals: replace<HypothesisProposal[]>(() => []),
  judgeErrors: replace<string[]>(() => []),
  rows: replace<RankedRow[]>(() => []),
  overflow: replace<Overflow[]>(() => []),
  plan: replace<PlanRow[]>(() => []),
  diff: replace<DecisionPayload["diffVsPrior"]>(() => []),
  noChange: replace<boolean>(() => false),
  newerDecisionId: replace<string | null>(() => null),
  violations: replace<G.GuardViolation[]>(() => []),
  payload: replace<DecisionPayload | null>(() => null),
  edo: replace<ReturnType<typeof emptyEdo> | null>(() => null),
  structuredResponse: replace<PrioritizerRunReport | undefined>(
    () => undefined
  ),
});
type S = typeof WorkPrioritizerState.State;

const ALLOWED: ReadonlySet<string> = new Set(T.WORK_PRIORITIZER_TOOL_IDS);

/** `2026-10-19T16:30:12.000Z` → `20261019t1630` (cycle id stamp, minute precision, UTC). */
function cycleStamp(nowIso: string): string {
  const d = new Date(nowIso);
  const iso = (Number.isNaN(d.getTime()) ? new Date() : d).toISOString();
  return iso.slice(0, 16).replace(/[-:]/g, "").replace("T", "t");
}

function messageText(msg: unknown): string {
  const c =
    typeof msg === "string" ? msg : (msg as { content?: unknown })?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c)
    ? c.map((p) => (typeof p === "string" ? p : String(p?.text ?? ""))).join("")
    : "";
}

function lastHumanText(messages: readonly BaseMessage[]): string {
  const role = (m: unknown) => {
    const x = m as { getType?: () => string; type?: string; role?: string };
    return x.getType?.() ?? x.type ?? x.role;
  };
  const human = [...messages]
    .reverse()
    .find((m) => role(m) === "human" || role(m) === "user");
  return human ? messageText(human) : "";
}

function modelRefOf(config: RunnableConfig | undefined): string | null {
  const model = (config?.configurable as { model?: unknown } | undefined)
    ?.model;
  return typeof model === "string" ? model : null;
}

const levelCountsOf = (rows: readonly RankedRow[]) =>
  [0, 1, 2, 3, 4].map((l) => rows.filter((r) => r.to === l).length);

/**
 * Create the work-prioritizer graph.
 *
 * ```
 * START → snapshot ─┬─ (incomplete | empty | no hub context) → finalize → END
 *                   └→ judge → rank_plan → emit_edo → finalize
 * ```
 *
 * NOTE: Return type is intentionally NOT annotated (TYPE_TRANSPARENT_RETURN).
 */
export function createWorkPrioritizerGraph(opts: CreateReactAgentGraphOptions) {
  const systemPrompt = opts.systemPrompt ?? WORK_PRIORITIZER_SYSTEM_PROMPT;
  const toolsByName = new Map<string, StructuredToolInterface>(
    opts.tools.map((t) => [t.name, t])
  );
  const llm = opts.llm as unknown as {
    invoke: (m: BaseMessage[], c?: RunnableConfig) => Promise<unknown>;
  };

  /** DETERMINISTIC_TOOL_CALLS: code names the tool; anything off the allowlist is a programming error. */
  async function callTool(
    name: string,
    args: Record<string, unknown>,
    config: RunnableConfig
  ): Promise<C.DecodedToolResult> {
    if (!ALLOWED.has(name)) {
      throw new Error(
        `work-prioritizer: tool '${name}' is not in its allowlist`
      );
    }
    const tool = toolsByName.get(name);
    if (!tool) return { ok: false, error: `tool_unavailable: ${name}` };
    try {
      return C.decodeToolResult(await tool.invoke(args, config));
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function snapshot(state: S, config: RunnableConfig) {
    const toolErrors: C.ToolCallError[] = [];
    const read = async (tool: string, args: Record<string, unknown>) => {
      const r = await callTool(tool, args, config);
      if (!r.ok) toolErrors.push({ tool, error: r.error });
      return r.ok ? r.value : undefined;
    };
    const { policy, fullReview } = policyFromTrigger(
      lastHumanText(state.messages)
    );
    if (!policy) return { fullReviewRequested: fullReview };
    const time = (await read(GET_CURRENT_TIME_NAME, {})) as
      | { currentTime?: unknown }
      | undefined;
    const now =
      typeof time?.currentTime === "string"
        ? time.currentTime
        : new Date().toISOString();

    // COMPLETE_SNAPSHOT_OR_ABORT: paginate every actionable item.
    const workItems: C.FetchedWorkItem[] = [];
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < T.MAX_SNAPSHOT_PAGES && !complete; page++) {
      const value = (await read(WORK_ITEM_QUERY_NAME, {
        ...T.BACKLOG_QUERY,
        statuses: [...T.BACKLOG_QUERY.statuses],
        ...(cursor ? { cursor } : {}),
      })) as { nextCursor?: unknown } | undefined;
      if (!value) break;
      workItems.push(...C.parseWorkItems(value));
      cursor =
        typeof value.nextCursor === "string" ? value.nextCursor : undefined;
      complete = !cursor;
    }

    // Hub context: fixed reads + every approved objective by id.
    const entries: C.FetchedEntry[] = [];
    for (const r of T.CONTEXT_READS) {
      entries.push(
        ...C.parseEntries(await read(r.tool, { ...r.args }), r.plane)
      );
    }
    for (const id of policy.objectives) {
      if (entries.some((e) => e.id === id)) continue;
      const value = await read(KNOWLEDGE_READ_NAME, { id });
      entries.push(...C.parseEntries(value, "edo"));
    }

    // Observe the items open hypotheses predicate on that the snapshot lacks (e.g. done ones).
    const observedStatus: Record<string, string> = Object.fromEntries(
      workItems.map((i) => [i.id, i.status])
    );
    const toObserve = P.openHypotheses(entries)
      .map((h) => h.predicate.itemId)
      .filter((id, k, all) => !observedStatus[id] && all.indexOf(id) === k)
      .slice(0, 50);
    if (toObserve.length > 0) {
      const value = await read(WORK_ITEM_QUERY_NAME, {
        ids: toObserve,
        limit: 50,
      });
      for (const i of C.parseWorkItems(value)) observedStatus[i.id] = i.status;
    }

    const context = C.buildGatheredContext({
      now,
      workItems,
      entries,
      toolErrors,
    });
    return {
      context,
      snapshotComplete: complete,
      policy,
      fullReviewRequested: fullReview,
      observedStatus,
      prior: P.newestPriorDecision(context.entries),
    };
  }

  function routeAfterSnapshot(state: S): string {
    const ctx = state.context;
    const usable =
      ctx &&
      state.snapshotComplete &&
      ctx.workItems.length > 0 &&
      !G.guardRunContext(ctx.contextConsumed);
    return usable ? "judge" : "finalize";
  }

  async function judge(state: S, config: RunnableConfig) {
    const ctx = state.context as C.GatheredContext;
    const policy = state.policy as WorkPrioritizationPolicy;
    const items = [...ctx.workItems].sort((a, b) => (a.id < b.id ? -1 : 1));
    const select = P.selectJudgeSet(items, state.prior, {
      now: ctx.now,
      promptVersion: WORK_PRIORITIZER_PROMPT_VERSION,
      objectives: policy.objectives,
      requested: state.fullReviewRequested,
      hubEntries: ctx.entries,
    });
    const triggerMessage = lastHumanText(state.messages);
    const judged = await judgeItems(
      select.toJudge,
      T.JUDGE_BATCH_SIZE,
      async (batch) => {
        const messages = [
          new SystemMessage(systemPrompt),
          new HumanMessage(
            buildJudgeUserMessage({ ctx, policy, batch, triggerMessage })
          ),
        ];
        // NO_TOOLS_AT_JUDGE: plain invoke (no bindTools); TRANSPORT_RETRY_ONCE on a stream drop.
        const reply = await llm
          .invoke(messages, config)
          .catch(() => llm.invoke(messages, config));
        return messageText(reply);
      }
    );
    return {
      scope: select.scope,
      delta: select.delta,
      judgments: Object.fromEntries([...select.carried, ...judged.judgments]),
      judgmentsReused: select.carried.size,
      unjudged: judged.unjudged,
      proposals: judged.hypotheses,
      judgeErrors: judged.errors,
      violations: judged.violations,
    };
  }

  function rankPlan(state: S) {
    const ctx = state.context as C.GatheredContext;
    const table = state.prior?.table ?? null;
    // Evidence is admissible if fetched this cycle, or by the cycle whose judgment is carried.
    const known = new Set<string>([
      ...ctx.workItems.map((i) => i.id),
      ...ctx.entries.map((e) => e.id),
      ...(state.prior?.memo.consumedIds ?? []),
    ]);
    const { rows, overflow } = rankItems({
      items: ctx.workItems.map((i) => ({
        ...i,
        priority: i.priority ?? null,
        rank: i.rank ?? null,
        // INCUMBENT_FROM_PRIOR_DECISION (propose mode never writes item fields).
        ...(table && { incumbent: table.get(i.id) ?? null }),
      })),
      judgments: new Map(Object.entries(state.judgments)),
      policy: state.policy as WorkPrioritizationPolicy,
      knownEvidenceIds: known,
      duplicateGroups: ctx.duplicateCandidates,
      blockerCycleMembers: new Set(ctx.blockerCycles.flat()),
    });
    const plan = P.buildPlan(rows);
    const diff = P.diffVsPrior(rows, table);
    // DECISION_ON_CHANGE: a full review always files (its decision records reviewedAt).
    const noChange =
      state.scope === "delta" && P.isNoChange(plan, diff, table !== null);
    return { rows, overflow, plan, diff, noChange };
  }

  async function emitEdo(state: S, config: RunnableConfig) {
    const ctx = state.context as C.GatheredContext;
    const p = state.policy as WorkPrioritizationPolicy;
    const now = new Date(ctx.now);
    const stamp = cycleStamp(ctx.now);
    const cycleId = `${T.PRIORITIZER_EDO_TAG}-${stamp}`;
    const common = {
      domain: G.selectEdoDomain(p.objectives, ctx.entries),
      sourceType: "agent",
      sourceRef: `langgraph:${WORK_PRIORITIZER_GRAPH_NAME}`,
      tags: [T.PRIORITIZER_EDO_TAG, "prioritization", "propose"],
    };
    const edo = emptyEdo();
    const call = async (tool: string, args: Record<string, unknown>) => {
      const r = await callTool(tool, args, config);
      if (!r.ok) edo.errors.push({ tool, error: r.error });
      return r;
    };
    const write = async (tool: string, args: Record<string, unknown>) => {
      edo.writes += 1;
      return (await call(tool, { ...common, ...args })).ok;
    };
    const violations = [...state.violations];
    const done = (extra: Partial<S> = {}) => ({ violations, edo, ...extra });

    // 0. PRIOR_CAS — abort before any write if another cycle filed after the prior this one planned
    //    on; an unreadable chain fails closed (no writes).
    const chain: string[] = [];
    for (const r of T.PRIOR_CHAIN_READS) {
      const res = await call(r.tool, { ...r.args });
      if (!res.ok) return done();
      chain.push(...C.parseEntries(res.value, r.plane).map((e) => e.id));
    }
    const newest = chain
      .filter((id) => P.DECISION_ID_RE.test(id))
      .sort()
      .at(-1);
    const priorId = state.prior?.id;
    if (newest && (!priorId || newest > priorId)) {
      return done({ newerDecisionId: newest });
    }

    // 1. Due hypotheses — record decidable outcomes (idempotent by outcome id).
    const open = P.openHypotheses(ctx.entries);
    const dueChecks: DueCheck[] = [];
    for (const { entry: h, observationSource, predicate } of open) {
      if (edo.outcomeIds.length >= T.MAX_OUTCOMES_PER_CYCLE) break;
      const observed = state.observedStatus[predicate.itemId];
      const result = P.evaluatePredicate(predicate, observed, now);
      if (result === "not_due") continue;
      const evidence =
        observed === undefined
          ? `${observationSource} not observed this cycle`
          : `${observationSource} status=${observed} at ${ctx.now}`;
      const outcomeId = `${h.id}-outcome`;
      const recorded =
        result !== "insufficient_evidence" &&
        (await write(EDO_RECORD_OUTCOME_NAME, {
          id: outcomeId,
          ...(h.domain !== "unknown" && { domain: h.domain }),
          title: `${result}: ${predicate.itemId} status ${predicate.equals} by ${predicate.by}`,
          content: `Observed ${evidence}. Predicate: ${JSON.stringify(predicate)}.`,
          hypothesisId: h.id,
          edge: result,
        }));
      if (recorded) edo.outcomeIds.push(outcomeId);
      dueChecks.push({ hypothesisId: h.id, result, evidence, recorded });
    }
    if (state.noChange) return done();

    // 2. New hypotheses — material uncertainty only, under the daily cap.
    const hubIds = ctx.entries.map((e) => e.id);
    const filedToday = P.hypothesesFiledToday(hubIds, now);
    const guarded = G.guardHypothesisProposals(state.proposals, {
      itemIds: new Set(ctx.workItems.map((i) => i.id)),
      hubIds: new Set(hubIds),
      now,
      remainingToday: Math.max(
        0,
        Math.min(T.MAX_HYPOTHESES_PER_CYCLE, p.hypothesesPerDay - filedToday)
      ),
    });
    violations.push(...guarded.violations);
    for (const [index, h] of guarded.accepted.entries()) {
      const id = `${cycleId}-h${index + 1}`;
      const { observationSource, predicate } = h;
      const block = JSON.stringify({ observationSource, predicate });
      const ok = await write(EDO_HYPOTHESIZE_NAME, {
        id,
        title: h.title,
        content: `${h.prediction}\n\n\`\`\`json\n${block}\n\`\`\``,
        evaluateAt: predicate.by,
        evidenceForIds: [...h.citations],
      });
      if (ok) edo.hypothesisIds.push(id);
    }

    // 3. The decision — the proposed plan. Derives from a new hypothesis, else the lead approved
    //    objective (goals are hypotheses), else the newest prior prioritizer hypothesis.
    const scope = state.scope ?? "full";
    const payload: DecisionPayload = {
      schemaVersion: DECISION_SCHEMA_VERSION,
      status: "planned",
      mode: "propose",
      scope,
      reviewedAt:
        scope === "full" ? ctx.now : (state.prior?.memo.reviewedAt ?? ctx.now),
      delta: state.delta,
      heuristic: RANK_HEURISTIC,
      policyVersion: p.policyVersion,
      promptVersion: WORK_PRIORITIZER_PROMPT_VERSION,
      modelRef: modelRefOf(config),
      cycleId,
      snapshotId: ctx.snapshotId,
      priorDecisionId: priorId ?? null,
      objectives: [...p.objectives],
      ceilings: { p0: p.p0Max, p1: p.p1Budget, p2: p.p2Budget },
      overflow: state.overflow,
      plan: state.plan,
      table: state.rows,
      diffVsPrior: state.diff,
      dueChecks,
      hypothesisIds: edo.hypothesisIds,
      contextConsumed: ctx.contextConsumed,
      judgments: ctx.workItems.flatMap((i) => {
        const judgment = state.judgments[i.id];
        return judgment
          ? [{ itemId: i.id, revision: i.revision, judgment }]
          : [];
      }),
      unjudged: state.unjudged,
    };
    const derivesFrom =
      edo.hypothesisIds[0] ??
      p.objectives.find((id) => hubIds.includes(id)) ??
      open.at(-1)?.entry.id;
    if (!derivesFrom) {
      const error = "no hypothesis to derive from";
      edo.errors.push({ tool: EDO_DECIDE_NAME, error });
      return done({ payload });
    }
    const p0 = state.rows.filter((r) => r.to === 0).map((r) => r.itemId);
    const counts = levelCountsOf(state.rows).map((n, l) => `p${l} ${n}`);
    const summary =
      `Proposed priorities (${RANK_HEURISTIC}, policy ${p.policyVersion}, ${scope} review): ` +
      `${counts.join(" · ")}; ${state.plan.length} changes; snapshot ${ctx.snapshotId}; ` +
      `prior ${priorId ?? "none"}.`;
    const id = `${cycleId}-decision`;
    const ok = await write(EDO_DECIDE_NAME, {
      id,
      title: `Priority plan ${stamp}: p0 ${p0.join(", ") || "none"}`,
      content: `${summary}\n\nPropose mode: nothing below is applied.\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
      derivesFromHypothesisId: derivesFrom,
    });
    if (ok) edo.decisionId = id;
    return done({ payload });
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
    const runViolation = state.context
      ? G.guardRunContext(state.context.contextConsumed)
      : null;
    const report: PrioritizerRunReport = {
      telemetry,
      payload: state.payload,
      guardViolations: [
        ...state.violations,
        ...(runViolation ? [runViolation] : []),
      ],
      toolErrors: [
        ...(state.context?.toolErrors ?? []),
        ...(state.edo?.errors ?? []),
      ],
      judgeErrors: state.judgeErrors,
    };
    return {
      structuredResponse: report,
      messages: [new AIMessage(JSON.stringify(telemetry))],
    };
  }

  return new StateGraph(WorkPrioritizerState)
    .addNode("snapshot", snapshot)
    .addNode("judge", judge)
    .addNode("rank_plan", rankPlan)
    .addNode("emit_edo", emitEdo)
    .addNode("finalize", finalize)
    .addEdge("__start__", "snapshot")
    .addConditionalEdges("snapshot", routeAfterSnapshot, ["judge", "finalize"])
    .addEdge("judge", "rank_plan")
    .addEdge("rank_plan", "emit_edo")
    .addEdge("emit_edo", "finalize")
    .addEdge("finalize", "__end__")
    .compile();
}

/** The cycle's flat telemetry (status + counts) from its final state. */
function telemetryOf(state: S, modelRef: string | null) {
  const ctx = state.context;
  const edo = state.edo ?? emptyEdo();
  const runViolation = ctx ? G.guardRunContext(ctx.contextConsumed) : null;
  const status: PrioritizerCycleStatus = !state.policy
    ? "no_policy"
    : !ctx || !state.snapshotComplete
      ? "incomplete_snapshot"
      : ctx.workItems.length === 0
        ? "no_backlog"
        : runViolation
          ? "rejected_context"
          : state.newerDecisionId
            ? "stale_prior"
            : state.noChange
              ? "no_change"
              : edo.decisionId
                ? "planned"
                : "decision_failed";
  const codes = new Map<string, number>();
  for (const v of [
    ...state.violations,
    ...(runViolation ? [runViolation] : []),
  ])
    codes.set(v.reason, (codes.get(v.reason) ?? 0) + 1);
  const judged = Object.keys(state.judgments).length;
  return {
    status,
    /** null when the cycle stopped before judging. */
    scope: state.scope,
    deltaSize: state.delta.length,
    snapshotId: ctx?.snapshotId ?? null,
    itemsInSnapshot: ctx?.workItems.length ?? 0,
    itemsJudged: judged,
    /** Judged by the model this cycle; the rest were carried from the prior decision. */
    judgedByModel: judged - state.judgmentsReused,
    judgmentsReused: state.judgmentsReused,
    unjudgedCount: state.unjudged.length,
    planRows: state.plan.length,
    levelCounts: levelCountsOf(state.rows),
    hypothesesFiled: edo.hypothesisIds.length,
    outcomesRecorded: edo.outcomeIds.length,
    decisionId: edo.decisionId,
    /** stale_prior only: the decision filed after this cycle read its prior (CAS loser). */
    newerDecisionId: state.newerDecisionId,
    edoWrites: edo.writes,
    guardViolations: [...codes.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([code, count]) => ({ code, count })),
    toolErrorCount: (ctx?.toolErrors.length ?? 0) + edo.errors.length,
    policyVersion: state.policy?.policyVersion ?? null,
    promptVersion: WORK_PRIORITIZER_PROMPT_VERSION,
    modelRef,
  };
}
