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

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  EDO_DECIDE_NAME,
  GOAL_LIST_NAME,
  KNOWLEDGE_READ_NAME,
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

const same = isDeepStrictEqual;

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
 * Code-graded guardrails for one run (0..1 each). EVERY_TICK_IMPROVES: deterministic over the transcript, so the
 * same scores land in the cycle log and can be replayed from a stored trace. These grade grounding and waste,
 * not usefulness: a run can score 1 everywhere and still be a poor judgment. Usefulness is a human rating.
 *   knowledge_read  — a correlated canonical id read returned a non-empty full body; receipts fingerprint those bytes
 *                     This is retrieval evidence, not proof the model applied the guidance.
 *   evidence_read   — at least one work-item query returned items
 *   goal_cited      — the decision derives from a listed goal and each Top-5 line cites a listed goal
 *   novel_change    — share of landed patches with a known baseline and different values (unknown baseline earns 0; no patches = 1)
 *   grounded        — distinct Top-5 item ids that were actually read this run (count / 5)
 *   action          — share of Top-5 lines whose `next:` carries real text
 */
export function cycleScores(messages: readonly BaseMessage[]) {
  const calls = toolCallArgs(messages);
  const seen = new Map<string, Snapshot>();
  const queryReadIds = new Set<string>();
  type Evidence = {
    readIds: Set<string>;
    goals: string[];
    knowledgeReads: number;
    itemsRead: number;
  };
  const pendingDecisions = new Map<string, Evidence>();
  let decisionEvidence: Evidence | undefined;
  let goalIds: string[] = [];
  const guidanceReceipts: Array<{
    id: string;
    sourceRef: string | null;
    sha256: string;
  }> = [];
  let itemsRead = 0;
  let patches = 0;
  let identicalPatches = 0;
  let novelPatches = 0;
  let unknownBaselinePatches = 0;
  let decision: { content: string; derivesFromHypothesisId: string } | null =
    null;
  for (const m of messages) {
    if (isAIMessage(m)) {
      for (const call of m.tool_calls ?? []) {
        if (call.name === EDO_DECIDE_NAME && call.id)
          pendingDecisions.set(call.id, {
            readIds: new Set(queryReadIds),
            goals: [...goalIds],
            knowledgeReads: guidanceReceipts.length,
            itemsRead,
          });
      }
    }
    if (!isToolMessage(m)) continue;
    const v = parse(text(m));
    if (!v || typeof v.error === "string" || v.success === false) continue;
    const call = m.tool_call_id ? calls.get(m.tool_call_id) : undefined;
    if (m.name === GOAL_LIST_NAME && Array.isArray(v.goals)) {
      goalIds = v.goals.map((g: { id?: unknown }) => String(g?.id));
    } else if (
      m.name === KNOWLEDGE_READ_NAME &&
      call?.name === KNOWLEDGE_READ_NAME &&
      typeof call.args.id === "string" &&
      v.mode === "get" &&
      Array.isArray(v.entries)
    ) {
      for (const entry of v.entries) {
        if (
          !entry ||
          typeof entry !== "object" ||
          entry.id !== call.args.id ||
          typeof entry.content !== "string" ||
          entry.content.trim().length === 0
        )
          continue;
        guidanceReceipts.push({
          id: entry.id,
          sourceRef:
            typeof entry.sourceRef === "string" ? entry.sourceRef : null,
          sha256: createHash("sha256")
            .update(entry.content, "utf8")
            .digest("hex"),
        });
      }
    } else if (m.name === WORK_ITEM_QUERY_NAME && Array.isArray(v.items)) {
      itemsRead += v.items.length;
      for (const it of v.items as Array<Record<string, unknown>>) {
        if (typeof it.id !== "string") continue;
        const snap: Snapshot = {};
        for (const f of PATCH_FIELDS) if (f in it) snap[f] = it[f];
        seen.set(it.id, snap);
        queryReadIds.add(it.id);
      }
    } else if (m.name === WORK_ITEM_TRANSITION_NAME && v.success === true) {
      const args = call?.args;
      if (args?.action !== "patch") continue;
      patches++;
      const prior = seen.get(String(v.id));
      const sent = PATCH_FIELDS.filter((f) => f in args);
      if (!prior || sent.length === 0 || !sent.every((f) => f in prior)) {
        unknownBaselinePatches++;
      } else if (sent.every((f) => same(prior[f], args[f]))) {
        identicalPatches++;
      } else {
        novelPatches++;
      }
      // A later patch in the same run compares against what this one wrote.
      const next: Snapshot = { ...prior };
      for (const f of sent) next[f] = args[f];
      seen.set(String(v.id), next);
    } else if (m.name === EDO_DECIDE_NAME && call?.name === EDO_DECIDE_NAME) {
      const a = call.args;
      decisionEvidence = pendingDecisions.get(m.tool_call_id);
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
  const evidenceIds = decisionEvidence?.readIds ?? queryReadIds;
  const evidenceGoals = decisionEvidence?.goals ?? goalIds;
  const grounded = new Set(topIds.filter((id) => evidenceIds.has(id))).size;
  const citesGoal = (l: string) =>
    evidenceGoals.some((g) => g && l.includes(g));
  const cited = topLines.filter(citesGoal).length;
  const withNext = topLines.filter((l) => {
    const action = l.match(/\bnext:\s*(.*)$/i)?.[1]?.trim() ?? "";
    return (
      action.length >= 3 &&
      /[\p{L}\p{N}]/u.test(action) &&
      !/^(?:tbd|todo|none|n\/a)$/i.test(action)
    );
  }).length;
  const derivesOk =
    decision !== null &&
    evidenceGoals.includes(decision.derivesFromHypothesisId);
  return {
    knowledgeReads: guidanceReceipts.length,
    guidanceReceipts,
    itemsRead,
    identicalPatches,
    unknownBaselinePatches,
    topIds,
    scores: {
      knowledge_read:
        (decisionEvidence?.knowledgeReads ?? guidanceReceipts.length) > 0
          ? 1
          : 0,
      evidence_read: (decisionEvidence?.itemsRead ?? itemsRead) > 0 ? 1 : 0,
      goal_cited:
        derivesOk && topLines.length > 0 ? cited / topLines.length : 0,
      novel_change: patches === 0 ? 1 : novelPatches / patches,
      grounded: grounded / 5,
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
