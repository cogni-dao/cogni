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

import { createHash } from "node:crypto";
import type { AiEvent } from "@cogni/ai-core";
import {
  CORE_TOOL_BUNDLE,
  createWorkItemReadImplementation,
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
import { COGNI_TOOL_IDS } from "../../../src/graphs/operator/cogni";
import { createOperatorGraph } from "../../../src/graphs/operator/graph";
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
  it("catalog entry binds the read-only common factory and cycle event", () => {
    const entry = OPERATOR_LANGGRAPH_CATALOG["work-prioritizer"];
    expect(entry.graphFactory).toBe(createOperatorGraph);
    expect(entry.toolIds).toEqual(COGNI_TOOL_IDS);
    expect(entry.toolIds).not.toContain(EDO_DECIDE_NAME);
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

describe("Cogni read-only common program", () => {
  async function qualify(
    options: {
      missingGuide?: boolean;
      printedCall?: boolean;
      terminal?: boolean;
      kind?: "knowledge" | "code";
      create?: boolean;
      inboxIncomplete?: boolean;
      codeUnknown?: boolean;
      recalledDomain?: string;
      createTarget?: string;
      missingRevision?: boolean;
    } = {}
  ) {
    const calls: string[] = [];
    const prompts: string[] = [];
    const events: AiEvent[] = [];
    let turn = 0;
    const codeCitation = `https://github.com/fixture/repo/blob/${"a".repeat(40)}/src/thing.ts#L1-L1`;

    const runner = createInProcGraphRunner({
      createGraph: createOperatorGraph,
      program: options.kind ? "cogni" : "work-review",
      sourceContext: {
        nodeId: "fixture-node",
        origin: "https://fixture.invalid",
        mission: {
          content: "Build a useful organization",
          sourceRef: "fixture:.cogni/repo-spec.yaml#intent.mission",
          buildSha: null,
        },
      },
      toolContracts: CORE_TOOL_BUNDLE.filter((t) =>
        (COGNI_TOOL_IDS as readonly string[]).includes(t.contract.name)
      ).map((t) => t.contract),
      completionFn: ({ messages }) => {
        const response = (value: CompletionResult) => ({
          stream: (async function* () {
            yield { type: "text_delta" as const, delta: "RAW UNVALIDATED" };
          })(),
          final: Promise.resolve(value),
        });
        prompts.push(JSON.stringify(messages));
        turn++;
        if (turn === 1)
          return response({
            ok: true,
            content: "",
            toolCalls: [
              {
                id: "full-work",
                type: "function",
                function: {
                  name:
                    options.kind === "knowledge"
                      ? "core__knowledge_read"
                      : options.kind === "code"
                        ? "core__node_code_read"
                        : "core__work_item_read",
                  arguments: JSON.stringify(
                    options.kind === "knowledge"
                      ? options.create
                        ? {
                            domain: options.recalledDomain ?? "reference",
                            limit: 50,
                          }
                        : { id: "reference-one" }
                      : options.kind === "code"
                        ? { path: "src/thing.ts" }
                        : { id: "task.5016" }
                  ),
                },
              },
            ],
          });
        if (options.printedCall)
          return response({
            ok: true,
            content: JSON.stringify({
              name: "core__edo_decide",
              arguments: { decision: "pretended" },
            }),
          });
        return response({
          ok: true,
          content: JSON.stringify({
            summary: "Defer blocked work; preserve the human's late constraint",
            items: [
              {
                kind: options.kind ?? "work",
                operation: options.create ? "create" : "refine",
                target:
                  options.kind === "knowledge"
                    ? options.create
                      ? (options.createTarget ??
                        "Proposed guide about a missing reference")
                      : "reference-one"
                    : options.kind === "code"
                      ? "src/thing.ts"
                      : "task.5016",
                ...(options.kind === "knowledge"
                  ? { domain: "reference" }
                  : {}),
                rationale: "Explicit human condition at end of full outcome",
                nextAction: "Ask the named reviewer for the missing decision",
                goalIds: ["goal-useful"],
                sourceIds: [
                  options.kind === "knowledge"
                    ? "reference-one"
                    : options.kind === "code"
                      ? codeCitation
                      : "task.5016",
                ],
                proposal:
                  "Keep blocked until the explicitly named reviewer responds",
              },
            ],
          }),
        });
      },
      createToolExecFn: () => async (name, args) => {
        calls.push(name);
        const input = args as Record<string, unknown>;
        if (name === KNOWLEDGE_READ_NAME)
          return {
            ok: true,
            value: {
              mode: input.id ? "get" : "list",
              entries: options.missingGuide
                ? []
                : [
                    {
                      id: input.id ?? "reference-one",
                      domain: input.domain ?? "reference",
                      content:
                        "Full owning guidance requires source-backed proposals",
                      sourceRef: `main:${input.id}`,
                    },
                  ],
              totalFound: 1,
            },
          };
        if (name === "core__knowledge_contribution_read")
          return {
            ok: true,
            value: {
              mode: "list_open",
              nodeId: "fixture-node",
              complete: !options.inboxIncomplete,
              contributions: [],
            },
          };
        if (name === GOAL_LIST_NAME)
          return {
            ok: true,
            value: {
              goals: [
                {
                  id: "goal-useful",
                  title: "Useful agent",
                  content: "Useful bounded review",
                  evaluateAt: null,
                },
              ],
            },
          };
        if (name === "core__node_code_read") {
          const content = "export const example = 1;";
          return {
            ok: true,
            value: {
              nodeId: "fixture-node",
              origin: "https://fixture.invalid",
              repo: "fixture/repo",
              commitSha: "a".repeat(40),
              path: input.path,
              citation: codeCitation,
              complete: !options.codeUnknown,
              exists: options.codeUnknown ? null : true,
              content,
              sha256: createHash("sha256").update(content).digest("hex"),
              lineStart: 1,
              lineEnd: 1,
              totalLines: 1,
              fileComplete: true,
            },
          };
        }
        if (name === "core__work_item_read") {
          const implementation = createWorkItemReadImplementation({
            workItemCapability: {
              query: async () => [
                {
                  id: "task.5016",
                  type: "task",
                  title: "Held reviewer decision",
                  status: options.terminal ? "cancelled" : "blocked",
                  ...(options.missingRevision ? {} : { revision: 9 }),
                  labels: [],
                  assignees: [],
                  updatedAt: "2026-10-27",
                  outcome: `${"x".repeat(900)} HUMAN: Wait for named reviewer before implementation.`,
                },
              ],
              transitionStatus: async () => {
                throw new Error("MUTATION DENIED");
              },
              patch: async () => {
                throw new Error("MUTATION DENIED");
              },
            },
          });
          return {
            ok: true,
            value: await implementation.execute({ id: String(input.id) }),
          };
        }
        throw new Error(`unexpected tool:${name}`);
      },
      request: {
        runId: "cogni-case",
        messages: [
          {
            role: "user",
            content: "Review actual work, proposed changes only",
          },
        ],
        configurable: { model: "test-model", toolIds: [...COGNI_TOOL_IDS] },
      },
    });
    for await (const event of runner.stream) events.push(event);
    return { result: await runner.final, calls, prompts, events };
  }
  it("reads canonical guidance before reasoning, retains late full-work constraints, and makes no writes", async () => {
    const run = await qualify();
    expect(run.calls).toContain("core__work_item_read");
    expect(run.result.ok).toBe(true);
    expect(run.prompts[1]).toContain("HUMAN: Wait for named reviewer");
    expect(JSON.stringify(run.result.structuredOutput)).toContain(
      '"status":"proposed"'
    );
    expect(run.prompts[0]).toContain("Full owning guidance");
    expect(run.prompts[1]).toContain("HUMAN: Wait for named reviewer");
    expect(
      run.calls.every((n) => (COGNI_TOOL_IDS as readonly string[]).includes(n))
    ).toBe(true);
    const finalEvents = run.events.filter(
      (event) => event.type === "assistant_final"
    );
    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0]).toMatchObject({ content: run.result.content });
    expect(run.result.content).toContain("**Next:** Ask the named reviewer");
    expect(run.result.content).toContain("<details>");
    const artifact = JSON.parse(
      run.result.content?.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? "null"
    );
    expect(artifact).toEqual(run.result.structuredOutput?.proposal);
    expect(
      artifact.receipts.find(
        (receipt: { id: string }) => receipt.id === "node-mission"
      )
    ).toMatchObject({
      nodeId: "fixture-node",
      origin: "https://fixture.invalid",
      content: "Build a useful organization",
      buildSha: null,
    });
    expect(run.calls).not.toContain(WORK_ITEM_TRANSITION_NAME);
    expect(run.calls).not.toContain(EDO_DECIDE_NAME);
    expect(run.events.filter((e) => e.type === "text_delta")).toHaveLength(0);
  });
  it("stops before the model when required canonical guidance is absent", async () => {
    const run = await qualify({ missingGuide: true });
    expect(run.prompts).toHaveLength(0);
    expect(JSON.stringify(run.result.structuredOutput)).toContain(
      '"status":"incomplete"'
    );
  });
  it("rejects a printed pretend tool call without executing it", async () => {
    const run = await qualify({ printedCall: true });
    expect(run.calls).not.toContain(EDO_DECIDE_NAME);
    expect(JSON.stringify(run.result.structuredOutput)).toContain(
      '"status":"incomplete"'
    );
  });
  it("rejects refinement of an already cancelled target", async () => {
    const run = await qualify({ terminal: true });
    expect(run.result.content).toContain(
      "proposal_work_target_unread_or_terminal"
    );
  });
  it("validates knowledge refinement after full canonical target and complete inbox recall", async () => {
    const run = await qualify({ kind: "knowledge" });
    expect(JSON.stringify(run.result.structuredOutput)).toContain(
      '"status":"proposed"'
    );
    expect(run.prompts[0]).toContain("knowledge-syntropy-protocol");
    expect(run.calls).toContain("core__knowledge_contribution_read");
  });
  it("requires complete canonical-domain recall before knowledge creation", async () => {
    const run = await qualify({ kind: "knowledge", create: true });
    expect(JSON.stringify(run.result.structuredOutput)).toContain(
      '"status":"proposed"'
    );
    expect(run.result.content).toContain(
      "Proposed guide about a missing reference"
    );
  });
  it("rejects knowledge claims when open-inbox recall is capped", async () => {
    const run = await qualify({ kind: "knowledge", inboxIncomplete: true });
    expect(run.result.content).toContain("knowledge_inbox_recall_incomplete");
  });
  it("binds code refinement to an actually read exact target and hash at immutable revision", async () => {
    const run = await qualify({ kind: "code" });
    expect(JSON.stringify(run.result.structuredOutput)).toContain(
      '"status":"proposed"'
    );
    expect(JSON.stringify(run.result.structuredOutput)).toContain(
      `fixture/repo@${"a".repeat(40)}`
    );
  });
  it("does not treat inaccessible code as read evidence or proven absence", async () => {
    const run = await qualify({ kind: "code", codeUnknown: true });
    expect(JSON.stringify(run.result.structuredOutput)).toContain(
      '"status":"incomplete"'
    );
  });
  it("does not let unrelated-domain recall authorize knowledge creation", async () => {
    const run = await qualify({
      kind: "knowledge",
      create: true,
      recalledDomain: "unrelated",
    });
    expect(JSON.stringify(run.result.structuredOutput)).toContain(
      "knowledge_create_recall_incomplete"
    );
  });
  it("does not propose creation of a canonical target already observed in preflight", async () => {
    const run = await qualify({
      kind: "knowledge",
      create: true,
      createTarget: "mission-loop-expert",
    });
    expect(JSON.stringify(run.result.structuredOutput)).toContain(
      "knowledge_create_target_already_observed"
    );
  });
  it("does not manufacture a work receipt from an undefined revision", async () => {
    const run = await qualify({ missingRevision: true });
    expect(JSON.stringify(run.result.structuredOutput)).toContain(
      '"status":"incomplete"'
    );
    expect(JSON.stringify(run.result.structuredOutput)).not.toContain(
      "work:task.5016:undefined"
    );
  });
});
