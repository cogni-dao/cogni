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
  KNOWLEDGE_READ_NAME,
  knowledgeReadContract,
  knowledgeSearchContract,
  WORK_ITEM_TRANSITION_NAME,
  workItemQueryContract,
  workItemTransitionContract,
} from "@cogni/ai-tools";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { OPERATOR_LANGGRAPH_CATALOG } from "../../../src/catalog";
import { COGNI_TOOL_IDS } from "../../../src/graphs/mission/cogni";
import { createMissionGraph } from "../../../src/graphs/mission/graph";
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
  it("catalog entry binds the common Cogni factory (reads + edo_decide) and cycle event", () => {
    const entry = OPERATOR_LANGGRAPH_CATALOG["work-prioritizer"];
    expect(entry.graphFactory).toBe(createMissionGraph);
    expect(entry.toolIds).toEqual(COGNI_TOOL_IDS);
    expect(entry.toolIds).toContain(EDO_DECIDE_NAME);
    expect(entry.toolIds).toContain(GET_CURRENT_TIME_NAME);
    expect(entry.toolIds).toContain(KNOWLEDGE_READ_NAME);
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
        knowledgeReadContract,
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
      guidanceReceipts: [],
      itemsRead: 0,
      identicalPatches: 0,
      unknownBaselinePatches: 1,
      topIds: [],
      scores: {
        knowledge_read: 0,
        evidence_read: 0,
        goal_cited: 0,
        novel_change: 0,
        grounded: 0,
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

  it("reads canonical guidance through the real runner and fingerprints exact returned bodies", async () => {
    const body = "Apply the owning rule.\nUse evidence before a change. 🧭";
    const executed: string[] = [];
    let turn = 0;
    const completionFn: CompletionFn = () => {
      const calls =
        turn++ === 0
          ? [
              {
                id: "guidance",
                name: KNOWLEDGE_READ_NAME,
                args: { id: "mission-loop-expert" },
              },
            ]
          : turn === 2
            ? [
                {
                  id: "patch",
                  name: WORK_ITEM_TRANSITION_NAME,
                  args: {
                    action: "patch",
                    id: "task.1",
                    rank: 0,
                    expectedRevision: 1,
                  },
                },
              ]
            : [];
      return {
        stream: (async function* () {})(),
        final: Promise.resolve(
          calls.length
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
            : {
                ok: true,
                content: "Read guidance before the patch.",
                finishReason: "stop",
              }
        ),
      };
    };
    const { stream, final } = createInProcGraphRunner({
      createGraph: createWorkPrioritizerGraph,
      completionFn,
      createToolExecFn: () => async (name) => {
        executed.push(name);
        return {
          ok: true,
          value:
            name === KNOWLEDGE_READ_NAME
              ? {
                  mode: "get",
                  entries: [
                    {
                      id: "mission-loop-expert",
                      domain: "build-agents",
                      entityId: null,
                      title: "Mission",
                      content: body,
                      sourceRef: "contribution:reviewed:2",
                      sourceType: "external",
                      confidencePct: 80,
                      tags: ["expertise-role"],
                    },
                  ],
                  totalFound: 1,
                }
              : {
                  success: true,
                  action: "patch",
                  id: "task.1",
                  revision: 2,
                  message: "ok",
                },
        };
      },
      toolContracts: [knowledgeReadContract, workItemTransitionContract],
      request: {
        runId: "guidance-run",
        messages: [{ role: "user", content: "Review priorities" }],
        configurable: {
          model: "test-model",
          toolIds: [...WORK_PRIORITIZER_TOOL_IDS],
        },
      },
    });
    for await (const _ of stream) {
      /* drain for billing */
    }
    const result = await final;
    expect(result.ok).toBe(true);
    expect(executed).toEqual([KNOWLEDGE_READ_NAME, WORK_ITEM_TRANSITION_NAME]);
    expect(result.structuredOutput?.telemetry).toMatchObject({
      knowledgeReads: 1,
      guidanceReceipts: [
        {
          id: "mission-loop-expert",
          sourceRef: "contribution:reviewed:2",
          sha256:
            "328c762dda41e780657c92f937dfb2b7442a309b6d9f9adc970811b866564a6a",
        },
      ],
      scores: { knowledge_read: 1 },
    });
  });

  it("does not count missing, empty, list-only or uncorrelated guidance as canonical reads", () => {
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "k",
            name: KNOWLEDGE_READ_NAME,
            args: { id: "mission-loop-expert" },
          },
        ],
      }),
      new ToolMessage({
        name: KNOWLEDGE_READ_NAME,
        tool_call_id: "k",
        content: JSON.stringify({
          mode: "get",
          entries: [
            { id: "mission-loop-expert", content: "", sourceRef: null },
          ],
        }),
      }),
      new ToolMessage({
        name: KNOWLEDGE_READ_NAME,
        tool_call_id: "unknown",
        content: JSON.stringify({
          mode: "get",
          entries: [
            { id: "mission-loop-expert", content: "unbound", sourceRef: null },
          ],
        }),
      }),
      new ToolMessage({
        name: KNOWLEDGE_READ_NAME,
        tool_call_id: "k",
        content: JSON.stringify({
          mode: "list",
          entries: [
            {
              id: "mission-loop-expert",
              content: "list result",
              sourceRef: null,
            },
          ],
        }),
      }),
      new ToolMessage({
        name: KNOWLEDGE_READ_NAME,
        tool_call_id: "k",
        content: JSON.stringify({
          mode: "get",
          entries: [
            { id: "another-entry", content: "wrong source", sourceRef: null },
          ],
        }),
      }),
    ];
    expect(cycleScores(messages)).toMatchObject({
      knowledgeReads: 0,
      guidanceReceipts: [],
      scores: { knowledge_read: 0 },
    });
  });

  it("rejects patch-manufactured reads, late reads and placeholder actions; compares objects by value", () => {
    const tool = (name: string, id: string, value: unknown) =>
      new ToolMessage({
        name,
        tool_call_id: id,
        content: JSON.stringify(value),
      });
    const ai = (name: string, id: string, args: Record<string, unknown>) =>
      new AIMessage({ content: "", tool_calls: [{ name, id, args }] });
    const content = [
      "Top 5:",
      ...[1, 2, 3, 4, 5].map(
        (n) => `${n}. task.${n} goal:goal-a — why — next: ...`
      ),
    ].join("\n");
    const decide = [
      ai(EDO_DECIDE_NAME, "d", { content, derivesFromHypothesisId: "goal-a" }),
      tool(EDO_DECIDE_NAME, "d", { committed: true }),
    ];
    const writes = [1, 2, 3, 4, 5].flatMap((n) => [
      ai(WORK_ITEM_TRANSITION_NAME, `p${n}`, {
        action: "patch",
        id: `task.${n}`,
        rank: n,
      }),
      tool(WORK_ITEM_TRANSITION_NAME, `p${n}`, {
        success: true,
        id: `task.${n}`,
      }),
    ]);
    expect(cycleScores([...writes, ...decide])).toMatchObject({
      itemsRead: 0,
      unknownBaselinePatches: 5,
      scores: { grounded: 0, novel_change: 0, action: 0 },
    });
    const lateReads = [
      ai(GOAL_LIST_NAME, "g", {}),
      tool(GOAL_LIST_NAME, "g", { goals: [{ id: "goal-a" }] }),
      ai("core__work_item_query", "q", {}),
      tool("core__work_item_query", "q", {
        items: [1, 2, 3, 4, 5].map((n) => ({ id: `task.${n}` })),
      }),
      ai(KNOWLEDGE_READ_NAME, "k", { id: "mission-loop-expert" }),
      tool(KNOWLEDGE_READ_NAME, "k", {
        mode: "get",
        entries: [{ id: "mission-loop-expert", content: "guidance" }],
      }),
    ];
    expect(cycleScores([...decide, ...lateReads]).scores).toMatchObject({
      knowledge_read: 0,
      evidence_read: 0,
      grounded: 0,
      goal_cited: 0,
      action: 0,
    });
    // A read in the same tool batch as a decision was not available when the decision was made.
    expect(
      cycleScores([
        lateReads[0],
        lateReads[1],
        decide[0],
        ...lateReads.slice(2),
        decide[1],
      ]).scores
    ).toMatchObject({ knowledge_read: 0, evidence_read: 0, grounded: 0 });
    const reordered = cycleScores([
      ai("core__work_item_query", "q", {}),
      tool("core__work_item_query", "q", {
        items: [
          { id: "task.1", scores: { value: 5, evidence: { a: 1, b: 2 } } },
        ],
      }),
      ai(WORK_ITEM_TRANSITION_NAME, "p", {
        action: "patch",
        id: "task.1",
        scores: { evidence: { b: 2, a: 1 }, value: 5 },
      }),
      tool(WORK_ITEM_TRANSITION_NAME, "p", { success: true, id: "task.1" }),
    ]);
    expect(reordered).toMatchObject({
      identicalPatches: 1,
      unknownBaselinePatches: 0,
      scores: { novel_change: 0 },
    });
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
      tool("k", "core__knowledge_search", {
        results: [{ id: "mission-loop-expert" }],
      }),
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
      // p3 re-sends what p2 just wrote → identical; p4 unseen item → unknown; p5 denied → not counted
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
    expect(s.knowledgeReads).toBe(0); // Search metadata is not a full guidance read.
    expect(s.identicalPatches).toBe(2);
    expect(s.topIds).toEqual([
      "story.1",
      "bug.2",
      "task.3",
      "task.4",
      "task.5",
    ]);
    expect(s.itemsRead).toBe(2);
    expect(s.scores).toEqual({
      knowledge_read: 0,
      evidence_read: 1,
      goal_cited: 0.8,
      novel_change: 0.25,
      grounded: 0.4, // only story.1 and bug.2 were read this run; task.3-5 are invented
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
    expect(off.scores.grounded).toBe(0);
    expect(cycleScores([]).scores).toEqual({
      knowledge_read: 0,
      evidence_read: 0,
      goal_cited: 0,
      novel_change: 1,
      grounded: 0,
      action: 0,
    });
    // Reviewer counterexample: empty search, no backlog read, one id repeated five times, blank next → fails closed.
    const fake = cycleScores([
      ai([{ id: "g", name: GOAL_LIST_NAME, args: {} }]),
      tool("g", GOAL_LIST_NAME, goals),
      ai([{ id: "k", name: "core__knowledge_search", args: {} }]),
      tool("k", "core__knowledge_search", { results: [] }),
      ai([
        {
          id: "d",
          name: EDO_DECIDE_NAME,
          args: {
            content: [
              "Top 5:",
              ...[1, 2, 3, 4, 5].map(
                (n) => `${n}. task.1 goal:goal-ai-work-converges — why — next:`
              ),
            ].join("\n"),
            derivesFromHypothesisId: "goal-ai-work-converges",
          },
        },
      ]),
      tool("d", EDO_DECIDE_NAME, { entry: { id: "x" }, committed: true }),
    ]);
    expect(fake.scores).toEqual({
      knowledge_read: 0,
      evidence_read: 0,
      goal_cited: 1,
      novel_change: 1,
      grounded: 0,
      action: 0,
    });
  });
});
