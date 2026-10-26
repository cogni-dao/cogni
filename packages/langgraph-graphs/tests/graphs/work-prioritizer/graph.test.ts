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
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { OPERATOR_LANGGRAPH_CATALOG } from "../../../src/catalog";
import {
  createWorkPrioritizerGraph,
  cycleScores,
} from "../../../src/graphs/work-prioritizer/graph";
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

/**
 * After turn 1 (goals + two patches: one lands, one p0/p1-denied): edo_decide + the report, a model error, or a
 * tool loop. "nochange": turn 1 reads goals only, then edo_decide + the report.
 */
type Then = "report" | "nochange" | "throw" | "loop";
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
  if (then === "nochange") turns[0] = [turns[0][0] as Call];
  if (then === "report" || then === "nochange") {
    turns.push([
      {
        id: "c4",
        name: EDO_DECIDE_NAME,
        args: {
          id: "mission-loop-20261023T00",
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
      edoDecisionId: "mission-loop-20261023T00",
      knowledgeReads: 0,
      identicalPatches: 0,
      topIds: [],
      scores: {
        knowledge_read: 0,
        goal_cited: 0,
        novel_change: 1,
        focus: 0,
        action: 0,
      },
      aborted: false,
      report: REPORT,
    });
  });

  it("a no-change run still records exactly one decision", async () => {
    const result = await run("nochange");

    expect(result.ok).toBe(true);
    expect(result.structuredOutput?.telemetry).toMatchObject({
      changedItemIds: [],
      changeCount: 0,
      edoDecisionId: "mission-loop-20261023T00",
      aborted: false,
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

  it("EVERY_TICK_IMPROVES: cycleScores grades hub reads, identical patches and the decision shape", () => {
    const goals = { goals: [{ id: "goal-ai-work-converges" }] };
    const items = {
      items: [
        { id: "story.1", priority: 2, rank: 0, labels: ["a"], revision: 3 },
        { id: "bug.2", priority: 3, rank: 1, labels: [], revision: 1 },
      ],
      count: 2,
    };
    const content = [
      "Since last tick: nothing new; guidance mission-loop-expert",
      "Top 5:",
      "1. story.1 goal:goal-ai-work-converges — why — next: open PR",
      "2. bug.2 goal:goal-ai-work-converges — why — next: reproduce",
      "3. task.3 goal:goal-ai-work-converges — why — next: design",
      "4. task.4 goal:goal-ai-work-converges — why",
      "5. task.5 — why — next: triage",
      "Changes: none",
      "Refine:",
      "1. task.9 goal:goal-ai-work-converges — outside the block — next: ignored",
    ].join("\n");
    const ai = (calls: Array<{ id: string; name: string; args: object }>) =>
      new AIMessage({ content: "", tool_calls: calls });
    const tool = (id: string, name: string, value: unknown) =>
      new ToolMessage({
        tool_call_id: id,
        name,
        content: JSON.stringify(value),
      });
    const messages = [
      ai([{ id: "g", name: GOAL_LIST_NAME, args: {} }]),
      tool("g", GOAL_LIST_NAME, goals),
      ai([
        {
          id: "k",
          name: "core__knowledge_search",
          args: { query: "mission loop" },
        },
      ]),
      tool("k", "core__knowledge_search", { results: [] }),
      ai([{ id: "q", name: "core__work_item_query", args: {} }]),
      tool("q", "core__work_item_query", items),
      ai([
        {
          id: "p1",
          name: WORK_ITEM_TRANSITION_NAME,
          args: {
            action: "patch",
            id: "story.1",
            priority: 2,
            labels: ["a"],
            expectedRevision: 3,
          },
        },
        {
          id: "p2",
          name: WORK_ITEM_TRANSITION_NAME,
          args: { action: "patch", id: "bug.2", rank: 0, expectedRevision: 1 },
        },
        {
          id: "p3",
          name: WORK_ITEM_TRANSITION_NAME,
          args: { action: "patch", id: "bug.2", rank: 0, expectedRevision: 2 },
        },
        {
          id: "p4",
          name: WORK_ITEM_TRANSITION_NAME,
          args: { action: "patch", id: "task.7", rank: 0 },
        },
        {
          id: "p5",
          name: WORK_ITEM_TRANSITION_NAME,
          args: { action: "patch", id: "story.1", rank: 9 },
        },
      ]),
      tool("p1", WORK_ITEM_TRANSITION_NAME, {
        success: true,
        action: "patch",
        id: "story.1",
        revision: 4,
      }),
      tool("p2", WORK_ITEM_TRANSITION_NAME, {
        success: true,
        action: "patch",
        id: "bug.2",
        revision: 2,
      }),
      // p3 re-sends what p2 just wrote → identical; p4 unseen item → novel; p5 denied → not counted
      tool("p3", WORK_ITEM_TRANSITION_NAME, {
        success: true,
        action: "patch",
        id: "bug.2",
        revision: 3,
      }),
      tool("p4", WORK_ITEM_TRANSITION_NAME, {
        success: true,
        action: "patch",
        id: "task.7",
        revision: 1,
      }),
      tool("p5", WORK_ITEM_TRANSITION_NAME, {
        success: false,
        code: "authz_denied",
        message: "authz_denied",
      }),
      ai([
        {
          id: "d",
          name: EDO_DECIDE_NAME,
          args: {
            id: "mission-loop-x",
            domain: "strategy",
            title: "t",
            content,
            derivesFromHypothesisId: "goal-ai-work-converges",
            sourceType: "agent",
          },
        },
      ]),
      tool("d", EDO_DECIDE_NAME, {
        entry: { id: "mission-loop-x" },
        committed: true,
      }),
    ];
    const s = cycleScores(messages);
    expect(s.knowledgeReads).toBe(1);
    expect(s.identicalPatches).toBe(2);
    expect(s.topIds).toEqual([
      "story.1",
      "bug.2",
      "task.3",
      "task.4",
      "task.5",
    ]);
    expect(s.scores).toEqual({
      knowledge_read: 1,
      goal_cited: 0.8,
      novel_change: 0.5,
      focus: 1,
      action: 0.8,
    });
    // derivesFromHypothesisId outside the listed goals → goal_cited 0; a failed knowledge search is not a read.
    const off = cycleScores([
      ai([{ id: "g", name: GOAL_LIST_NAME, args: {} }]),
      tool("g", GOAL_LIST_NAME, goals),
      ai([{ id: "k", name: "core__knowledge_search", args: {} }]),
      tool("k", "core__knowledge_search", { error: "boom" }),
      ai([
        {
          id: "d",
          name: EDO_DECIDE_NAME,
          args: { content, derivesFromHypothesisId: "goal-made-up" },
        },
      ]),
      tool("d", EDO_DECIDE_NAME, { entry: { id: "x" }, committed: true }),
    ]);
    expect(off.scores.goal_cited).toBe(0);
    expect(off.scores.knowledge_read).toBe(0);
    expect(off.scores.focus).toBe(1);
    expect(cycleScores([]).scores).toEqual({
      knowledge_read: 0,
      goal_cited: 0,
      novel_change: 1,
      focus: 0,
      action: 0,
    });
  });
});
