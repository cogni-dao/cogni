// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/graphs/work-prioritizer/plan`
 * Purpose: Scenario tests for planning, the no-change rule, and EDO evidence helpers (design v4 §2.4–§2.7, §4).
 * Scope: Pure functions; does not invoke an LLM, tools, or the graph.
 * Invariants: PLAN_IS_CHANGED_ROWS, NO_CHANGE_NO_DECISION, PREDICATES_ARE_DECIDABLE, daily cap counting.
 * Side-effects: none
 * Links: src/graphs/work-prioritizer/plan.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  buildPlan,
  diffVsPrior,
  isNoChange,
  newestPriorDecision,
  selectJudgeSet,
} from "../../../src/graphs/work-prioritizer/plan";
import type { RankedRow } from "../../../src/graphs/work-prioritizer/schema";

function row(
  itemId: string,
  from: number | null,
  to: number,
  o: Partial<RankedRow> = {}
): RankedRow {
  return {
    itemId,
    revision: 4,
    from,
    fromRank: 1,
    to,
    rank: 1,
    pinned: false,
    serviceClass: "standard",
    maxImpact: 1,
    goal: null,
    effort: "M",
    whyNow: null,
    harmIfWait: null,
    reasons: [],
    ...o,
  };
}

describe("plan", () => {
  it("PLAN_IS_CHANGED_ROWS with expectedRevision; pinned rows never planned", () => {
    expect(
      buildPlan([
        row("a", 0, 0),
        row("b", 0, 3),
        row("c", null, 3),
        row("d", 2, 0, { pinned: true }),
      ])
    ).toEqual([
      { itemId: "b", from: 0, to: 3, rank: 1, expectedRevision: 4 },
      { itemId: "c", from: null, to: 3, rank: 1, expectedRevision: 4 },
    ]);
  });

  it("NO_CHANGE_NO_DECISION: empty plan, or same table as the prior decision", () => {
    const rows = [row("a", 0, 3)];
    const prior = new Map([["a", 3]]);
    const plan = buildPlan(rows);
    expect(isNoChange([], diffVsPrior(rows, null), false)).toBe(true);
    expect(isNoChange(plan, diffVsPrior(rows, prior), true)).toBe(true);
    expect(isNoChange(plan, diffVsPrior(rows, new Map([["a", 1]])), true)).toBe(
      false
    );
    expect(isNoChange(plan, diffVsPrior(rows, null), false)).toBe(false);
  });

  it("diffVsPrior lists changed and new rows", () => {
    expect(
      diffVsPrior([row("a", 0, 1), row("b", 0, 2)], new Map([["a", 1]]))
    ).toEqual([{ itemId: "b", priorTo: null, to: 2 }]);
  });

  it("parses the newest prior decision's table from its fenced json; v0 decisions carry none", () => {
    const prior = (id: string, content: string) =>
      newestPriorDecision([{ id: `work-prioritizer-${id}-decision`, content }]);
    const content = 'summary\n```json\n{"table":[{"itemId":"a","to":2}]}\n```';
    expect(prior("20261020t1100", content)?.table).toEqual(new Map([["a", 2]]));
    expect(
      prior("20261020t1100", 'x\n```json\n{"focusOrder":["a"]}\n```')?.table
    ).toBeNull();
    expect(prior("20261020t1100", "no json")?.table).toBeNull();
    expect(
      newestPriorDecision([
        { id: "work-prioritizer-20261020t1100-decision", content },
        { id: "work-prioritizer-20261020t1200-decision", content: "x" },
      ])?.id
    ).toBe("work-prioritizer-20261020t1200-decision");
  });
});

describe("DAILY_FULL_REVIEW + DELTA_SCOPE + MEMOIZED_JUDGMENTS (selectJudgeSet)", () => {
  const judgment = (itemId: string) => ({
    itemId,
    impact: { "dao-goal-a": 2 },
    serviceClass: "standard",
    fixedDate: null,
    effort: "M",
    whyNow: { text: "w", evidenceId: itemId },
    harmIfWait: { text: "h", evidenceId: itemId, withinDays: null },
    supersededBy: null,
  });
  const prior = (o: Record<string, unknown> = {}) =>
    newestPriorDecision([
      {
        id: "work-prioritizer-20261020t1100-decision",
        content: `x\n\`\`\`json\n${JSON.stringify({
          promptVersion: "v",
          goals: ["dao-goal-a"],
          reviewedAt: "2026-10-20T00:01:00.000Z",
          contextConsumed: {
            workItemIds: ["p0.1", "p3.1", "p3.2"],
            knowledgeIds: ["k-old"],
            edoIds: [],
          },
          table: [
            { itemId: "p0.1", to: 0 },
            { itemId: "p3.1", to: 3 },
            { itemId: "p3.2", to: 3 },
          ],
          judgments: ["p0.1", "p3.1", "p3.2"].map((id) => ({
            itemId: id,
            revision: 3,
            judgment: judgment(id),
          })),
          ...o,
        })}\n\`\`\``,
      },
    ]);
  const items = [
    { id: "p0.1", revision: 3, priority: 0 },
    { id: "p3.1", revision: 3, priority: 3 },
    { id: "p3.2", revision: 3, priority: 3 },
    { id: "new.1", revision: 1, priority: 2 },
  ];
  const ctx = {
    now: "2026-10-20T12:00:00.000Z",
    promptVersion: "v",
    goals: ["dao-goal-a"],
    requested: false,
    hubEntries: [{ id: "k-old", content: "mentions p3.1" }],
  };

  it("delta cycle: delta = p0/p1 + unprioritized + changed/new; unchanged items carry with no model call", () => {
    const out = selectJudgeSet(
      [...items, { id: "unset.1", revision: 3 }],
      prior(),
      ctx
    );
    expect(out.scope).toBe("delta");
    expect(out.delta).toEqual(["p0.1", "new.1", "unset.1"]);
    expect(out.toJudge.map((i) => i.id)).toEqual(["new.1", "unset.1"]);
    expect([...out.carried.keys()]).toEqual(["p0.1", "p3.1", "p3.2"]);
  });

  it("a changed revision joins the delta and is re-judged; new hub evidence re-judges a delta item only", () => {
    const changed = items.map((i) =>
      i.id === "p3.2" ? { ...i, revision: 4 } : i
    );
    const evidence = {
      ...ctx,
      hubEntries: [
        ...ctx.hubEntries,
        { id: "k-new", content: "incident on p0.1 and p3.1" },
      ],
    };
    const out = selectJudgeSet(changed, prior(), evidence);
    expect(out.delta).toEqual(["p0.1", "p3.2", "new.1"]);
    // p0.1 is in the delta and newly evidenced → re-judged; p3.1 is outside the delta → carried.
    expect(out.toJudge.map((i) => i.id)).toEqual(["p0.1", "p3.2", "new.1"]);
    expect(out.carried.has("p3.1")).toBe(true);
  });

  it("full review: requested, no prior, no reviewedAt, new prompt/goals, or a new UTC day", () => {
    const full = (p: ReturnType<typeof prior>, c = ctx) =>
      selectJudgeSet(items, p, c);
    expect(full(prior(), { ...ctx, requested: true }).scope).toBe("full");
    expect(full(null).scope).toBe("full");
    expect(full(prior({ reviewedAt: undefined })).scope).toBe("full");
    expect(full(prior(), { ...ctx, promptVersion: "v2" }).scope).toBe("full");
    expect(full(prior(), { ...ctx, goals: ["dao-goal-b"] }).scope).toBe("full");
    const nextDay = full(prior(), { ...ctx, now: "2026-10-21T00:05:00.000Z" });
    expect(nextDay).toMatchObject({ scope: "full" });
    expect(nextDay.toJudge).toHaveLength(items.length);
    expect(nextDay.delta).toEqual(items.map((i) => i.id));
    expect(nextDay.carried.size).toBe(0);
  });

  it("a v0 decision has nothing to reuse", () => {
    const v0 = newestPriorDecision([
      {
        id: "work-prioritizer-20261020t1100-decision",
        content: 'x\n```json\n{"focusOrder":[]}\n```',
      },
    ]);
    expect(v0?.judgments.size).toBe(0);
  });
});

describe("EVERY_PLACED_ITEM_GETS_ITS_RANK", () => {
  it("plans a p0 row whose priority is unchanged but whose rank is unset or moved", () => {
    const unset = row("bug.5005", 0, 0, { fromRank: null, rank: 1 });
    const moved = row("bug.5003", 0, 0, { fromRank: 7, rank: 2 });
    const same = row("bug.5002", 0, 0, { fromRank: 3, rank: 3 });
    expect(buildPlan([unset, moved, same])).toEqual([
      { itemId: "bug.5005", from: 0, to: 0, rank: 1, expectedRevision: 4 },
      { itemId: "bug.5003", from: 0, to: 0, rank: 2, expectedRevision: 4 },
    ]);
  });
});
