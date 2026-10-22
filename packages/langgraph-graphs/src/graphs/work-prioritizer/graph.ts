// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/graph`
 * Purpose: Mission-loop agent: a ReAct agent that reads the DAO goals and makes a few goal-cited work-item changes.
 * Scope: Pure graph factory (createReactAgent + one report node). Does NOT read env, log, or enforce authz.
 * Invariants:
 *   - LLM and tools are injected, not instantiated (brain-style)
 *   - PURE_GRAPH_FACTORY: the run report is `structuredResponse.telemetry`; the provider logs it (catalog `report`)
 *   - TYPE_TRANSPARENT_RETURN: No explicit return type annotation
 * Side-effects: none
 * Links: story.5108, prompts.ts, tools.ts
 * @public
 */

import { GOAL_LIST_NAME, WORK_ITEM_TRANSITION_NAME } from "@cogni/ai-tools";
import { type BaseMessage, isToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  Annotation,
  MessagesAnnotation,
  StateGraph,
} from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import type { CreateReactAgentGraphOptions } from "../types";
import { WORK_PRIORITIZER_SYSTEM_PROMPT } from "./prompts";

export const WORK_PRIORITIZER_GRAPH_NAME = "work-prioritizer" as const;

const REPORT_MAX_CHARS = 2048;

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

/** One flat cycle summary from the run's messages (safe to log). */
export function cycleTelemetry(messages: readonly BaseMessage[]) {
  let goalIds: string[] | undefined;
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
    }
  }
  return {
    ...(goalIds && { goalIds }),
    changedItemIds,
    changeCount: changedItemIds.length,
    deniedCount,
    toolErrorCount,
    report: text(messages.at(-1)).slice(0, REPORT_MAX_CHARS),
  };
}

export type MissionLoopTelemetry = ReturnType<typeof cycleTelemetry>;

const State = Annotation.Root({
  ...MessagesAnnotation.spec,
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
    .addNode("agent", (s: S, config: RunnableConfig) =>
      agent.invoke({ messages: s.messages }, config)
    )
    .addNode("report", (s: S) => ({
      structuredResponse: { telemetry: cycleTelemetry(s.messages) },
    }))
    .addEdge("__start__", "agent")
    .addEdge("agent", "report")
    .addEdge("report", "__end__")
    .compile()
    .withConfig({ recursionLimit: 50 });
}
