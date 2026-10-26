// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/graph`
 * Purpose: Mission-loop agent: a ReAct agent that reads the DAO goals and makes a few goal-cited work-item changes.
 * Scope: Pure graph factory (createReactAgent + one report node). Does NOT read env, log, or enforce authz.
 * Invariants:
 *   - LLM and tools are injected, not instantiated (brain-style)
 *   - PURE_GRAPH_FACTORY: the run report is `structuredResponse.telemetry`; the provider logs it (catalog `report`)
 *   - REPORT_ON_TURN_LIMIT: only a GraphRecursionError (turn limit) reaches the report node with the partial
 *     transcript, `aborted: true` and `abortReason`; every other error (model, transport, cancel) is rethrown so
 *     the run fails and the provider's error log fires
 *   - TYPE_TRANSPARENT_RETURN: No explicit return type annotation
 * Side-effects: none
 * Links: story.5108, story.5116, prompts.ts, tools.ts
 *   - EVERY_TICK_IMPROVES: `cycleScores` grades each run in code (knowledge_read, goal_cited, novel_change, focus, action)
 * @public
 */

import {
  EDO_DECIDE_NAME,
  GOAL_LIST_NAME,
  KNOWLEDGE_SEARCH_NAME,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_TRANSITION_NAME,
} from "@cogni/ai-tools";
import {
  type BaseMessage,
  isAIMessage,
  isToolMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  Annotation,
  GraphRecursionError,
  MessagesAnnotation,
  StateGraph,
} from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import type { CreateReactAgentGraphOptions } from "../types";
import { WORK_PRIORITIZER_SYSTEM_PROMPT } from "./prompts";

export const WORK_PRIORITIZER_GRAPH_NAME = "work-prioritizer" as const;

const REPORT_MAX_CHARS = 2048;
const ABORT_REASON_MAX_CHARS = 300;

const text = (m: BaseMessage | undefined): string => {
  const c = m?.content;
  return Array.isArray(c)
    ? c
        .map((p) => (typeof p === "string" ? p : "text" in p ? p.text : ""))
        .join("")
    : String(c ?? "");
};

const parse = (s: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

const ITEM_ID = /\b(?:story|task|bug|spike|subtask)\.\d+\b/;
const TOP_LINE = /^\s*[1-5]\.\s/;
const PATCH_FIELDS = [
  "priority",
  "rank",
  "labels",
  "summary",
  "scores",
] as const;

type Snapshot = Partial<Record<(typeof PATCH_FIELDS)[number], unknown>>;

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** Tool-call args keyed by tool_call id, from every AI message in the transcript. */
function toolCallArgs(
  messages: readonly BaseMessage[]
): Map<string, { name: string; args: Record<string, unknown> }> {
  const out = new Map<
    string,
    { name: string; args: Record<string, unknown> }
  >();
  for (const m of messages) {
    if (!isAIMessage(m)) continue;
    for (const c of m.tool_calls ?? []) {
      if (c.id) out.set(c.id, { name: c.name, args: c.args ?? {} });
    }
  }
  return out;
}

/**
 * Code-graded scores for one run (0..1 each). EVERY_TICK_IMPROVES: the grader is deterministic over the transcript,
 * so the same scores land in the cycle log and can be replayed from a stored trace.
 *   knowledge_read  — at least one successful knowledge search (the hub was consulted)
 *   goal_cited      — the decision derives from a listed goal and each Top-5 line cites a listed goal
 *   novel_change    — share of landed patches whose values differ from what the run read (1 when no patches)
 *   focus           — Top-5 lines present, each naming an item id (count / 5)
 *   action          — share of Top-5 lines that carry a `next:` action
 */
export function cycleScores(messages: readonly BaseMessage[]) {
  const calls = toolCallArgs(messages);
  const seen = new Map<string, Snapshot>();
  let goalIds: string[] = [];
  let knowledgeReads = 0;
  let patches = 0;
  let identicalPatches = 0;
  let decision: { content: string; derivesFromHypothesisId: string } | null =
    null;
  for (const m of messages) {
    if (!isToolMessage(m)) continue;
    const v = parse(text(m));
    if (!v || typeof v.error === "string" || v.success === false) continue;
    const call = m.tool_call_id ? calls.get(m.tool_call_id) : undefined;
    if (m.name === GOAL_LIST_NAME && Array.isArray(v.goals)) {
      goalIds = v.goals.map((g: { id?: unknown }) => String(g?.id));
    } else if (m.name === KNOWLEDGE_SEARCH_NAME) {
      knowledgeReads++;
    } else if (m.name === WORK_ITEM_QUERY_NAME && Array.isArray(v.items)) {
      for (const it of v.items as Array<Record<string, unknown>>) {
        if (typeof it.id !== "string") continue;
        const snap: Snapshot = {};
        for (const f of PATCH_FIELDS) if (f in it) snap[f] = it[f];
        seen.set(it.id, snap);
      }
    } else if (m.name === WORK_ITEM_TRANSITION_NAME && v.success === true) {
      const args = call?.args;
      if (args?.action !== "patch") continue;
      patches++;
      const prior = seen.get(String(v.id));
      const sent = PATCH_FIELDS.filter((f) => f in args);
      if (
        prior &&
        sent.length > 0 &&
        sent.every((f) => f in prior && same(prior[f], args[f]))
      ) {
        identicalPatches++;
      }
      // A later patch in the same run compares against what this one wrote.
      const next: Snapshot = { ...prior };
      for (const f of sent) next[f] = args[f];
      seen.set(String(v.id), next);
    } else if (m.name === EDO_DECIDE_NAME && call?.name === EDO_DECIDE_NAME) {
      const a = call.args;
      decision = {
        content: String(a.content ?? ""),
        derivesFromHypothesisId: String(a.derivesFromHypothesisId ?? ""),
      };
    }
  }
  // Only the `Top 5:` block counts, up to the next section label.
  const lines = (decision?.content ?? "").split("\n");
  const start = lines.findIndex((l) => /^\s*Top 5:/i.test(l));
  const block = start < 0 ? [] : lines.slice(start + 1);
  const end = block.findIndex((l) =>
    /^\s*(Changes|Proposals|Refine)\b/i.test(l)
  );
  const topLines = (end < 0 ? block : block.slice(0, end))
    .filter((l) => TOP_LINE.test(l) && ITEM_ID.test(l))
    .slice(0, 5);
  const topIds = topLines.map((l) => l.match(ITEM_ID)?.[0] ?? "");
  const citesGoal = (l: string) => goalIds.some((g) => g && l.includes(g));
  const cited = topLines.filter(citesGoal).length;
  const withNext = topLines.filter((l) => /\bnext:/i.test(l)).length;
  const derivesOk =
    decision !== null && goalIds.includes(decision.derivesFromHypothesisId);
  return {
    knowledgeReads,
    identicalPatches,
    topIds,
    scores: {
      knowledge_read: knowledgeReads > 0 ? 1 : 0,
      goal_cited:
        derivesOk && topLines.length > 0 ? cited / topLines.length : 0,
      novel_change: patches === 0 ? 1 : 1 - identicalPatches / patches,
      focus: Math.min(1, topLines.length / 5),
      action: topLines.length > 0 ? withNext / topLines.length : 0,
    },
  };
}

/** One flat cycle summary from the run's messages (safe to log). */
export function cycleTelemetry(
  messages: readonly BaseMessage[],
  abortReason?: string
) {
  const aborted = abortReason !== undefined;
  let goalIds: string[] | undefined;
  let edoDecisionId: string | undefined;
  const changedItemIds: string[] = [];
  let deniedCount = 0;
  let toolErrorCount = 0;
  for (const m of messages) {
    if (!isToolMessage(m)) continue;
    const raw = text(m);
    const v = parse(raw);
    if (!v || typeof v.error === "string" || v.success === false) {
      if (raw.includes("authz_denied")) deniedCount++;
      else toolErrorCount++;
    } else if (m.name === GOAL_LIST_NAME && Array.isArray(v.goals)) {
      goalIds = v.goals.map((g: { id?: unknown }) => String(g?.id));
    } else if (m.name === WORK_ITEM_TRANSITION_NAME && v.success === true) {
      changedItemIds.push(String(v.id));
    } else if (m.name === EDO_DECIDE_NAME) {
      const id = (v.entry as { id?: unknown } | undefined)?.id;
      if (typeof id === "string") edoDecisionId = id;
    }
  }
  return {
    ...(goalIds && { goalIds }),
    changedItemIds,
    changeCount: changedItemIds.length,
    deniedCount,
    toolErrorCount,
    ...(edoDecisionId && { edoDecisionId }),
    ...cycleScores(messages),
    aborted,
    ...(aborted && {
      abortReason: abortReason.slice(0, ABORT_REASON_MAX_CHARS),
    }),
    report: aborted ? "" : text(messages.at(-1)).slice(0, REPORT_MAX_CHARS),
  };
}

export type MissionLoopTelemetry = ReturnType<typeof cycleTelemetry>;

const State = Annotation.Root({
  ...MessagesAnnotation.spec,
  abortReason: Annotation<string | undefined>(),
  structuredResponse: Annotation<{ telemetry: MissionLoopTelemetry }>(),
});

/** Brain-style ReAct agent, then one node that turns the transcript into the run report. */
export function createWorkPrioritizerGraph(opts: CreateReactAgentGraphOptions) {
  const agent = createReactAgent({
    llm: opts.llm,
    tools: [...opts.tools],
    messageModifier: WORK_PRIORITIZER_SYSTEM_PROMPT,
    stateSchema: MessagesAnnotation,
  });
  type S = typeof State.State;
  return new StateGraph(State)
    .addNode("agent", async (s: S, config: RunnableConfig) => {
      // REPORT_ON_TURN_LIMIT: keep the latest transcript so a turn-limit abort still reports what landed.
      let last: { messages: BaseMessage[] } = { messages: s.messages };
      try {
        const values = await agent.stream(
          { messages: s.messages },
          { ...config, streamMode: "values" }
        );
        for await (const v of values) last = v;
        return last;
      } catch (error) {
        if (!(error instanceof GraphRecursionError)) throw error;
        return { ...last, abortReason: "recursion_limit" };
      }
    })
    .addNode("report", (s: S) => ({
      structuredResponse: {
        telemetry: cycleTelemetry(s.messages, s.abortReason),
      },
    }))
    .addEdge("__start__", "agent")
    .addEdge("agent", "report")
    .addEdge("report", "__end__")
    .compile()
    .withConfig({ recursionLimit: 50 });
}
