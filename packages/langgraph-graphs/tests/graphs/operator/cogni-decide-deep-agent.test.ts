// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/graphs/operator/cogni-decide-deep-agent`
 * Purpose: Falsifiable proof that a SCHEDULED mission tick runs the deep-agent trajectory on the cogni engine: explicit plan → Flash subagent reads goals + ledger → actuates ONLY the materially-changed item's scores via the narrow writer (CAS, ≤5) or no-ops → ZERO EDO, never a priority/status write.
 * Scope: Runs through the real in-proc runner + real CogniCompletionAdapter with a scripted fake CompletionFn and fake tool results. Does not call a real LLM, hub or network.
 * Invariants:
 *   - PLAN_IS_EXPLICIT / SUBAGENT_DELEGATION / BILLED_PATH_ONLY: as the READ deep-agent proof
 *   - NARROW_WRITER_ONLY: the only write is core__work_item_transition {action:patch,id,expectedRevision,scores}; no model is ever bound that tool
 *   - ACTUATE_ONLY_ON_MATERIAL_CHANGE: unchanged items are never written; hostile/over-budget proposals are rejected in code
 *   - NO_EDO: core__edo_decide is offered to the runner but never bound or executed
 * Side-effects: none
 * Links: src/graphs/operator/cogni-decide.ts · https://cognidao.org/work/items/task.5377
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import {
  EDO_DECIDE_NAME,
  edoDecideContract,
  GOAL_LIST_NAME,
  goalListContract,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_TRANSITION_NAME,
  workItemQueryContract,
  workItemTransitionContract,
} from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import {
  LANGGRAPH_CATALOG,
  OPERATOR_LANGGRAPH_CATALOG,
  OPERATOR_LANGGRAPH_GRAPH_IDS,
} from "../../../src/catalog";
import {
  COGNI_DECIDE_TOOL_IDS,
  MAX_SCORE_WRITES_PER_TICK,
  SCORES_WRITE_NAME,
} from "../../../src/graphs/operator/cogni-decide";
import { FLASH_SUBAGENT_MODEL } from "../../../src/graphs/operator/cogni-read";
import { createOperatorGraph } from "../../../src/graphs/operator/graph";
import { createInProcGraphRunner } from "../../../src/inproc/runner";
import type { CompletionFn, ToolExecFn } from "../../../src/inproc/types";

const PARENT_MODEL = "parent-model";
const TICK = "scheduled mission tick";
const EV = "https://cognidao.org/work/items/bug.9001";

const GOALS = {
  goals: [
    {
      id: "goal-ai-work-converges",
      title: "AI work converges faster than it sprawls",
      evaluateAt: "2026-12-16",
      content: "CR >= 1.00 with guardrail held.",
    },
    {
      id: "goal-prod-deploys-land",
      title: "Production deploys land reliably",
      evaluateAt: "2026-12-02",
      content: ">= 90% weekly prod deploy success.",
    },
  ],
};

function wi(
  id: string,
  status: string,
  revision: number,
  scores: Record<string, { v: number; ev?: string }>
) {
  return {
    id,
    type: "task",
    title: `title of ${id}`,
    status,
    priority: 2,
    labels: [],
    assignees: [],
    updatedAt: "2026-10-28",
    revision,
    scores,
  };
}

/** bug.9001 materially changed (now blocking prod deploys, still scored low); the rest match their scores. */
const LEDGER = {
  count: 4,
  items: [
    wi("bug.9001", "needs_implement", 7, {
      goal: { v: 1 },
      time: { v: 1 },
    }),
    wi("task.9002", "needs_closeout", 3, {
      goal: { v: 3 },
      ease: { v: 4, ev: EV },
    }),
    wi("story.9003", "needs_design", 12, { goal: { v: 1 } }),
    wi("task.9004", "needs_implement", 5, { goal: { v: 2 }, time: { v: 2 } }),
  ],
};

type Seen = { model: string; tools: string[]; roles: string[] };
type Proposal = Record<string, unknown>;

const DIGEST =
  "GOALS: goal-ai-work-converges; goal-prod-deploys-land. ITEMS: bug.9001 rev7 goal:1 time:1; task.9002 rev3; story.9003 rev12; task.9004 rev5. MATERIAL CHANGES: bug.9001 now blocks goal-prod-deploys-land (failed promote), score stale.";

function script(
  seen: Seen[],
  opts: {
    goals?: unknown;
    decide: () => { proposals?: Proposal[]; content?: string };
  }
): CompletionFn {
  return (req) => {
    const tools = (req.tools ?? []).map(
      (t) => (t as { function: { name: string } }).function.name
    );
    seen.push({
      model: req.model,
      tools,
      roles: req.messages.map((m) => m.role),
    });
    const done = (r: Record<string, unknown>) => ({
      stream: (async function* () {})(),
      final: Promise.resolve({ ok: true as const, finishReason: "stop", ...r }),
    });
    const call = (id: string, name: string, args: unknown) => ({
      id,
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    });

    if (tools.includes("write_todos"))
      return done({
        toolCalls: [
          call("p1", "write_todos", {
            todos: [
              {
                content: "Delegate goal + ledger read to subagent",
                status: "in_progress",
              },
              { content: "Find materially changed items", status: "pending" },
              {
                content: "Write scores for those only, else no-op",
                status: "pending",
              },
            ],
          }),
        ],
      });

    if (req.model === FLASH_SUBAGENT_MODEL) {
      if (!req.messages.some((m) => m.role === "tool"))
        return done({
          toolCalls: [
            call("s1", GOAL_LIST_NAME, {}),
            call("s2", WORK_ITEM_QUERY_NAME, {}),
          ],
        });
      return done({ content: DIGEST });
    }

    // DECIDE — parent model with ONLY the scores proposer bound.
    const d = opts.decide();
    if (d.proposals?.length)
      return done({
        toolCalls: d.proposals.map((p, i) =>
          call(`d${i}`, SCORES_WRITE_NAME, p)
        ),
      });
    return done({
      content: d.content ?? "NO_CHANGE: nothing materially changed",
    });
  };
}

async function runTick(
  decide: () => { proposals?: Proposal[]; content?: string },
  goals: unknown = GOALS,
  ledger: unknown = LEDGER
) {
  const seen: Seen[] = [];
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const createToolExecFn =
    (_emit: (e: AiEvent) => void): ToolExecFn =>
    async (name, args) => {
      executed.push({ name, args: args as Record<string, unknown> });
      if (name === GOAL_LIST_NAME) return { ok: true, value: goals };
      if (name === WORK_ITEM_QUERY_NAME) return { ok: true, value: ledger };
      if (name === WORK_ITEM_TRANSITION_NAME)
        return {
          ok: true,
          value: {
            success: true,
            action: "patch",
            id: (args as { id: string }).id,
            message: "Patched",
            revision: 8,
          },
        };
      return { ok: true, value: {} };
    };

  const { stream, final } = createInProcGraphRunner({
    program: "cogni-decide",
    sourceContext: {
      nodeId: "test-node",
      origin: "https://test.example",
      mission: {
        content: "Test mission.",
        sourceRef: "test:mission",
        buildSha: null,
      },
    },
    createGraph: createOperatorGraph,
    completionFn: script(seen, { decide }),
    createToolExecFn,
    // The write contracts (EDO + the host transition tool) are OFFERED to the runner as in prod.
    toolContracts: [
      goalListContract,
      workItemQueryContract,
      workItemTransitionContract,
      edoDecideContract,
    ],
    request: {
      runId: "decide-1",
      messages: [{ role: "user", content: TICK }],
      configurable: {
        model: PARENT_MODEL,
        toolIds: [...COGNI_DECIDE_TOOL_IDS],
      },
    },
  });
  const events: AiEvent[] = [];
  for await (const e of stream) events.push(e);
  const result = await final;
  const writes = executed.filter((e) => e.name === WORK_ITEM_TRANSITION_NAME);
  const telemetry = (
    result.ok
      ? (result.structuredOutput as { telemetry: Record<string, unknown> })
          .telemetry
      : {}
  ) as Record<string, unknown>;
  return { seen, executed, events, result, writes, telemetry };
}

/** Invariants that hold on EVERY tick, whatever the model does. */
function expectNeverEdoNeverBroadWrite(r: Awaited<ReturnType<typeof runTick>>) {
  const bound = r.seen.flatMap((s) => s.tools);
  // No model is ever bound the EDO tool or the host transition tool.
  expect(bound).not.toContain(EDO_DECIDE_NAME);
  expect(bound).not.toContain(WORK_ITEM_TRANSITION_NAME);
  expect(r.executed.map((e) => e.name)).not.toContain(EDO_DECIDE_NAME);
  expect(
    r.events.filter(
      (e) => e.type === "tool_call_start" && e.toolName === EDO_DECIDE_NAME
    )
  ).toHaveLength(0);
  // Every write is a bare scores patch with CAS: nothing else is ever sent.
  expect(r.writes.length).toBeLessThanOrEqual(MAX_SCORE_WRITES_PER_TICK);
  for (const w of r.writes) {
    expect(Object.keys(w.args).sort()).toEqual(
      ["action", "expectedRevision", "id", "scores"].sort()
    );
    expect(w.args.action).toBe("patch");
    expect(typeof w.args.expectedRevision).toBe("number");
  }
  expect(r.telemetry.edoDecisions).toBe(0);
}

describe("cogni scheduled DECIDE deep agent (task.5377)", () => {
  it("plans, delegates the ledger read to Flash, writes ONLY the materially-changed item's scores, and files nothing else", async () => {
    const r = await runTick(() => ({
      proposals: [
        {
          id: "bug.9001",
          expectedRevision: 7,
          scores: { goal: { v: 3 }, time: { v: 3 } },
          change: "now blocks goal-prod-deploys-land",
          confidence: "high",
        },
      ],
    }));

    expect(r.result.ok).toBe(true);
    // plan -> Flash subagent (tool turn, digest turn) -> decide with ONLY the scores proposer bound.
    expect(r.seen.map((s) => `${s.model}[${s.tools.join(",")}]`)).toEqual([
      `${PARENT_MODEL}[write_todos]`,
      `${FLASH_SUBAGENT_MODEL}[${GOAL_LIST_NAME},${WORK_ITEM_QUERY_NAME}]`,
      `${FLASH_SUBAGENT_MODEL}[${GOAL_LIST_NAME},${WORK_ITEM_QUERY_NAME}]`,
      `${PARENT_MODEL}[${SCORES_WRITE_NAME}]`,
    ]);
    // isolation: the subagent's first turn sees system prompt + its task only.
    expect(r.seen[1]?.roles).toEqual(["system", "user"]);

    // Exactly the material-change write, via the host writer, with CAS, merged onto live scores.
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]?.args).toEqual({
      action: "patch",
      id: "bug.9001",
      expectedRevision: 7,
      scores: { goal: { v: 3 }, time: { v: 3 } },
    });
    // NO write for the unchanged items.
    expect(r.writes.map((w) => w.args.id)).not.toContain("task.9002");
    expect(r.writes.map((w) => w.args.id)).not.toContain("story.9003");
    expect(r.writes.map((w) => w.args.id)).not.toContain("task.9004");

    expect(r.telemetry).toMatchObject({
      mode: "decide",
      noop: false,
      writes: 1,
      written: ["bug.9001"],
      subagentModel: FLASH_SUBAGENT_MODEL,
      goalCount: 2,
      itemsRead: 4,
    });
    expectNeverEdoNeverBroadWrite(r);
  });

  it("NO-OPS (zero writes) when the model sees no material change", async () => {
    const r = await runTick(() => ({
      content: "NO_CHANGE: all scores current",
    }));
    expect(r.result.ok).toBe(true);
    expect(r.writes).toHaveLength(0);
    expect(r.telemetry).toMatchObject({
      noop: true,
      writes: 0,
      reason: "model_no_change",
    });
    expectNeverEdoNeverBroadWrite(r);
  });

  it("rejects hostile or non-material proposals in code: unchanged scores, wrong revision, unread item, low confidence, missing evidence, over budget", async () => {
    const material = (id: string, rev: number) => ({
      id,
      expectedRevision: rev,
      scores: { goal: { v: 5, ev: EV } },
      change: "stale",
      confidence: "high",
    });
    const r = await runTick(() => ({
      proposals: [
        // unchanged: identical to live scores -> no write
        {
          id: "task.9002",
          expectedRevision: 3,
          scores: { goal: { v: 3 } },
          change: "x",
          confidence: "high",
        },
        // wrong revision (hallucinated) -> no write
        { ...material("story.9003", 99) },
        // not read this tick -> no write
        { ...material("task.404", 1) },
        // low confidence -> no write
        { ...material("task.9004", 5), confidence: "low" },
        // v>=4 without evidence -> no write
        {
          id: "task.9004",
          expectedRevision: 5,
          scores: { goal: { v: 4 } },
          change: "x",
          confidence: "high",
        },
        // the one valid proposal
        material("bug.9001", 7),
        // a hostile attempt to smuggle a priority/status write is not even in the schema
        {
          id: "story.9003",
          expectedRevision: 12,
          scores: { goal: { v: 2 } },
          change: "x",
          confidence: "high",
          priority: 0,
          status: "done",
        },
        // repeat proposals for an item already written this tick
        ...["a", "b", "c", "d", "e", "f"].map((n) => ({
          id: "bug.9001",
          expectedRevision: 7,
          scores: { goal: { v: 5, ev: EV } },
          change: n,
          confidence: "high",
        })),
      ],
    }));
    expect(r.result.ok).toBe(true);
    // Only bug.9001 (first valid) and story.9003 (valid, unknown extras stripped by the schema) land.
    const ids = r.writes.map((w) => w.args.id);
    expect(ids).toEqual(["bug.9001", "story.9003"]);
    expect(r.writes[1]?.args).toEqual({
      action: "patch",
      id: "story.9003",
      expectedRevision: 12,
      scores: { goal: { v: 2 } },
    });
    const reasons = (
      r.telemetry.skipped as Array<{ id: string; reason: string }>
    ).map((s) => `${s.id}:${s.reason}`);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "task.9002:no_material_change",
        "story.9003:revision_not_the_live_read",
        "task.404:item_not_read_this_tick",
        "task.9004:confidence_low",
        "task.9004:evidence_required_for_v4_plus",
        "bug.9001:duplicate_item",
      ])
    );
    expectNeverEdoNeverBroadWrite(r);
  });

  it("never exceeds the per-tick write budget (8 stale items -> 5 writes, 3 skipped)", async () => {
    const many = {
      count: 8,
      items: Array.from({ length: 8 }, (_, i) =>
        wi(`task.80${i}`, "needs_implement", i + 1, { goal: { v: 1 } })
      ),
    };
    const proposals = many.items.map((it) => ({
      id: it.id,
      expectedRevision: it.revision,
      scores: { goal: { v: 2 } },
      change: "stale",
      confidence: "high",
    }));
    const r = await runTick(() => ({ proposals }), GOALS, many);
    expect(r.writes).toHaveLength(MAX_SCORE_WRITES_PER_TICK);
    expect(r.writes.map((w) => w.args.id)).toEqual(
      many.items.slice(0, 5).map((it) => it.id)
    );
    expect(
      (r.telemetry.skipped as Array<{ reason: string }>).filter(
        (s) => s.reason === "tick_write_budget_exhausted"
      )
    ).toHaveLength(3);
    expectNeverEdoNeverBroadWrite(r);
  });

  it("no-ops without a decide model call when no goals were read", async () => {
    const r = await runTick(
      () => {
        throw new Error("decide model must not be called with no goals");
      },
      { goals: [] }
    );
    expect(r.result.ok).toBe(true);
    expect(r.writes).toHaveLength(0);
    expect(r.telemetry).toMatchObject({ noop: true, reason: "no_goals" });
    expect(r.seen.some((s) => s.tools.includes(SCORES_WRITE_NAME))).toBe(false);
    expectNeverEdoNeverBroadWrite(r);
  });

  it("is registered in the OPERATOR catalog beside work-prioritizer, with reads + scores writer and NO edo_decide", () => {
    const entry = OPERATOR_LANGGRAPH_CATALOG["cogni-decide"];
    expect(entry).toBeDefined();
    expect(entry.graphFactory).toBe(createOperatorGraph);
    expect(entry.program).toBe("cogni-decide");
    expect(entry.toolIds).toEqual(COGNI_DECIDE_TOOL_IDS);
    expect(entry.toolIds).not.toContain(EDO_DECIDE_NAME);
    expect(OPERATOR_LANGGRAPH_GRAPH_IDS["cogni-decide"]).toBe(
      "langgraph:cogni-decide"
    );
    expect(OPERATOR_LANGGRAPH_CATALOG["work-prioritizer"]).toBeDefined();
    // Operator-only: the node-runtime catalog never advertises it.
    expect(LANGGRAPH_CATALOG["cogni-decide"]).toBeUndefined();
  });

  it("the fixed scores-patch shape the actuate node sends satisfies the real core__work_item_transition contract", () => {
    const ok = workItemTransitionContract.inputSchema.safeParse({
      action: "patch",
      id: "bug.9001",
      expectedRevision: 7,
      scores: { goal: { v: 3 }, time: { v: 4, ev: EV } },
    });
    expect(ok.success).toBe(true);
    // scores without CAS, or with priority, is rejected by the contract itself.
    expect(
      workItemTransitionContract.inputSchema.safeParse({
        action: "patch",
        id: "bug.9001",
        scores: { goal: { v: 3 } },
      }).success
    ).toBe(false);
    expect(
      workItemTransitionContract.inputSchema.safeParse({
        action: "patch",
        id: "bug.9001",
        expectedRevision: 7,
        priority: 0,
        scores: { goal: { v: 3 } },
      }).success
    ).toBe(false);
  });
});
