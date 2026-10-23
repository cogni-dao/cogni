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
  EDO_DECIDE_NAME,
  edoDecideContract,
  GET_CURRENT_TIME_NAME,
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

/** After turn 1 (goals + two patches: one lands, one p0/p1-denied): edo_decide + the report, a model error, or a tool loop. */
type Then = "report" | "throw" | "loop";
function scriptedCompletion(prompts: string[], then: Then): CompletionFn {
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
  if (then === "report") {
    turns.push([
      {
        id: "c4",
        name: EDO_DECIDE_NAME,
        args: {
          id: "mission-loop-20261023T0000",
          domain: "strategy",
          title: "Mission loop 2026-10-23T00:00Z",
          content: REPORT,
          derivesFromHypothesisId: "goal-ai-work-converges",
          sourceType: "agent",
        },
      },
    ]);
  }
  let n = 0;
  return (req) => {
    prompts.push(JSON.stringify(req.messages[0]));
    const loop = then === "loop" && [
      { id: `l${n}`, name: GOAL_LIST_NAME, args: {} },
    ];
    const calls = turns[n++] ?? loop;
    if (!calls && then === "throw") throw new Error("model down");
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
    if (name === EDO_DECIDE_NAME) {
      const a = args as { id: string; domain: string; title: string };
      return {
        ok: true,
        value: {
          entry: {
            id: a.id,
            domain: a.domain,
            title: a.title,
            confidencePct: null,
            sourceType: "agent",
          },
          derivesFromHypothesisId: "goal-ai-work-converges",
          committed: true,
          message: "filed",
        },
      };
    }
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
  it("catalog entry wires the factory, the six tools, and the cycle event", () => {
    const entry = OPERATOR_LANGGRAPH_CATALOG["work-prioritizer"];
    expect(entry.graphFactory).toBe(createWorkPrioritizerGraph);
    expect(entry.toolIds).toEqual(WORK_PRIORITIZER_TOOL_IDS);
    expect(entry.toolIds).toHaveLength(6);
    expect(entry.toolIds).toContain(EDO_DECIDE_NAME);
    expect(entry.toolIds).toContain(GET_CURRENT_TIME_NAME);
    expect(entry.report).toEqual({ event: "ai.work_prioritizer.cycle" });
  });

  async function run(then: Then, prompts: string[] = []) {
    const { stream, final } = createInProcGraphRunner({
      createGraph: createWorkPrioritizerGraph,
      completionFn: scriptedCompletion(prompts, then),
      createToolExecFn: fakeExec,
      toolContracts: [
        goalListContract,
        workItemQueryContract,
        workItemTransitionContract,
        knowledgeSearchContract,
        edoDecideContract,
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
    return final;
  }

  it("runs the tool loop and returns one flat cycle report", async () => {
    const prompts: string[] = [];
    const result = await run("report", prompts);

    expect(result.ok).toBe(true);
    expect(result.content).toBe(REPORT);
    expect(prompts[0]).toContain(WORK_PRIORITIZER_SYSTEM_PROMPT.slice(0, 40));
    expect(result.structuredOutput?.telemetry).toEqual({
      goalIds: ["goal-ai-work-converges", "goal-fleet-pays-itself"],
      changedItemIds: ["task.1"],
      changeCount: 1,
      deniedCount: 1,
      toolErrorCount: 0,
      edoDecisionId: "mission-loop-20261023T0000",
      aborted: false,
      report: REPORT,
    });
  });

  it("REPORT_ON_TURN_LIMIT: a turn-limit abort still reports the changes that landed", async () => {
    const result = await run("loop");

    expect(result.ok).toBe(true);
    expect(result.structuredOutput?.telemetry).toMatchObject({
      changedItemIds: ["task.1"],
      changeCount: 1,
      deniedCount: 1,
      aborted: true,
      abortReason: "recursion_limit",
      report: "",
    });
  });

  it("a model error fails the run (not swallowed as aborted)", async () => {
    const result = await run("throw");

    expect(result.ok).toBe(false);
    expect(result.structuredOutput).toBeUndefined();
  });
});
