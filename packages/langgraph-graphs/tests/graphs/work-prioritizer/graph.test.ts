// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/graphs/work-prioritizer/graph`
 * Purpose: The mission-loop ReAct agent runs its tools through the real in-proc runner and returns one flat cycle report.
 * Scope: Scripted completions + fake tool exec; does not call a real LLM or store.
 * Invariants:
 *   - CATALOG_WIRES_FOUR_TOOLS: the catalog entry carries the factory, the four tool ids, and the cycle event
 *   - CYCLE_REPORT: changed ids come only from successful transitions; denials and errors are counted apart
 * Side-effects: none
 * Links: src/graphs/work-prioritizer/graph.ts
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import {
  GOAL_LIST_NAME,
  goalListContract,
  knowledgeSearchContract,
  WORK_ITEM_TRANSITION_NAME,
  workItemQueryContract,
  workItemTransitionContract,
} from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";

import { OPERATOR_LANGGRAPH_CATALOG } from "../../../src/catalog";
import { createWorkPrioritizerGraph } from "../../../src/graphs/work-prioritizer/graph";
import { WORK_PRIORITIZER_SYSTEM_PROMPT } from "../../../src/graphs/work-prioritizer/prompts";
import { WORK_PRIORITIZER_TOOL_IDS } from "../../../src/graphs/work-prioritizer/tools";
import { createInProcGraphRunner } from "../../../src/inproc/runner";
import type {
  CompletionFn,
  CompletionResult,
  ToolExecFn,
} from "../../../src/inproc/types";

const REPORT =
  "Changed task.1 priority 3→2 (goal-ai-work-converges). Proposal: bug.2 → p1 (goal-fleet-pays-itself).";

type Call = { id: string; name: string; args: Record<string, unknown> };

/** Turn 1: read goals + two transitions (one lands, one is p0/p1-denied); turn 2: the report. */
function scriptedCompletion(prompts: string[]): CompletionFn {
  const turns: Call[][] = [
    [
      { id: "c1", name: GOAL_LIST_NAME, args: {} },
      {
        id: "c2",
        name: WORK_ITEM_TRANSITION_NAME,
        args: {
          action: "patch",
          id: "task.1",
          priority: 2,
          expectedRevision: 4,
        },
      },
      {
        id: "c3",
        name: WORK_ITEM_TRANSITION_NAME,
        args: {
          action: "patch",
          id: "bug.2",
          priority: 1,
          expectedRevision: 1,
        },
      },
    ],
  ];
  let n = 0;
  return (req) => {
    prompts.push(JSON.stringify(req.messages[0]));
    const calls = turns[n++];
    const final: Promise<CompletionResult> = Promise.resolve(
      calls
        ? {
            ok: true,
            content: "",
            finishReason: "tool_calls",
            toolCalls: calls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
        : { ok: true, content: REPORT, finishReason: "stop" }
    );
    return { stream: (async function* () {})(), final };
  };
}

const fakeExec: (emit: (e: AiEvent) => void) => ToolExecFn =
  () => async (name, args) => {
    if (name === GOAL_LIST_NAME) {
      return {
        ok: true,
        value: {
          goals: [
            {
              id: "goal-ai-work-converges",
              title: "t",
              evaluateAt: null,
              content: "c",
            },
            {
              id: "goal-fleet-pays-itself",
              title: "t",
              evaluateAt: null,
              content: "c",
            },
          ],
        },
      };
    }
    const a = args as { id: string; priority: number };
    return a.priority <= 1
      ? {
          ok: false,
          errorCode: "execution",
          safeMessage: `authz_denied: priority ${a.priority} requires node admin`,
        }
      : {
          ok: true,
          value: {
            success: true,
            action: "patch",
            id: a.id,
            message: "ok",
            revision: 5,
          },
        };
  };

describe("work-prioritizer mission-loop agent", () => {
  it("catalog entry wires the factory, the four tools, and the cycle event", () => {
    const entry = OPERATOR_LANGGRAPH_CATALOG["work-prioritizer"];
    expect(entry.graphFactory).toBe(createWorkPrioritizerGraph);
    expect(entry.toolIds).toEqual(WORK_PRIORITIZER_TOOL_IDS);
    expect(entry.report).toEqual({ event: "ai.work_prioritizer.cycle" });
  });

  it("runs the tool loop and returns one flat cycle report", async () => {
    const prompts: string[] = [];
    const { stream, final } = createInProcGraphRunner({
      createGraph: createWorkPrioritizerGraph,
      completionFn: scriptedCompletion(prompts),
      createToolExecFn: fakeExec,
      toolContracts: [
        goalListContract,
        workItemQueryContract,
        workItemTransitionContract,
        knowledgeSearchContract,
      ],
      request: {
        runId: "run-1",
        messages: [{ role: "user", content: "PRIORITIZE" }],
        configurable: {
          model: "test-model",
          toolIds: [...WORK_PRIORITIZER_TOOL_IDS],
        },
      },
    });
    for await (const _ of stream) {
      // drain
    }
    const result = await final;

    expect(result.ok).toBe(true);
    expect(result.content).toBe(REPORT);
    expect(prompts[0]).toContain(WORK_PRIORITIZER_SYSTEM_PROMPT.slice(0, 40));
    expect(result.structuredOutput?.telemetry).toEqual({
      goalIds: ["goal-ai-work-converges", "goal-fleet-pays-itself"],
      changedItemIds: ["task.1"],
      changeCount: 1,
      deniedCount: 1,
      toolErrorCount: 0,
      report: REPORT,
    });
  });
});
