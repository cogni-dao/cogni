// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/graphs/work-prioritizer/guards`
 * Purpose: Unit tests for the v4 run guards, judge parsing, policy parsing, context derivation, and schemas.
 * Scope: Pure-function tests with fixtures; does not invoke an LLM, tools, or the graph.
 * Invariants: CONTEXT_BEFORE_JUDGMENT, POLICY_FROM_TRIGGER, ENUMS_NOT_FLOATS, TOLERANT_PARSING.
 * Side-effects: none
 * Links: src/graphs/work-prioritizer/{guards,policy,context,schema}.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  buildGatheredContext,
  computeSnapshotId,
  dedupeWorkItems,
  type FetchedEntry,
  type FetchedWorkItem,
  findBlockerCycles,
  findDuplicateTitleGroups,
  parseGoals,
} from "../../../src/graphs/work-prioritizer/context";
import {
  hasHubContext,
  selectEdoDomain,
} from "../../../src/graphs/work-prioritizer/guards";
import { policyFromTrigger } from "../../../src/graphs/work-prioritizer/policy";
import {
  judgeItems,
  normalizeJudgment,
  parseHarmDays,
  parseJudgeOutput,
} from "../../../src/graphs/work-prioritizer/prompts";
import { ItemJudgmentSchema } from "../../../src/graphs/work-prioritizer/schema";

const NOW = new Date("2026-10-20T12:00:00.000Z");

function item(id: string, o: Partial<FetchedWorkItem> = {}): FetchedWorkItem {
  return {
    id,
    type: "task",
    title: `Title ${id}`,
    status: "needs_implement",
    revision: 1,
    labels: [],
    ...o,
  };
}
function entry(
  id: string,
  plane: FetchedEntry["plane"],
  domain = "operator"
): FetchedEntry {
  return {
    id,
    domain,
    title: id,
    content: "c",
    confidencePct: 50,
    tags: [],
    plane,
  };
}
const J = {
  itemId: "task.1",
  impact: { "dao-goal-a": 2 },
  serviceClass: "standard",
  effort: "M",
  whyNow: { text: "w", evidenceId: "task.1" },
  harmIfWait: { text: "h", evidenceId: "task.1", withinDays: null },
};

describe("schemas (ENUMS_NOT_FLOATS)", () => {
  it("accepts enums + evidence; rejects floats, out-of-range impact, fixed_date without a date", () => {
    expect(ItemJudgmentSchema.safeParse(J).success).toBe(true);
    expect(
      ItemJudgmentSchema.safeParse({ ...J, impact: { a: 2.5 } }).success
    ).toBe(false);
    expect(
      ItemJudgmentSchema.safeParse({ ...J, impact: { a: 4 } }).success
    ).toBe(false);
    expect(
      ItemJudgmentSchema.safeParse({ ...J, serviceClass: "fixed_date" }).success
    ).toBe(false);
    expect(
      ItemJudgmentSchema.safeParse({
        ...J,
        serviceClass: "fixed_date",
        fixedDate: "2026-11-01",
      }).success
    ).toBe(true);
    expect(ItemJudgmentSchema.safeParse({ ...J, effort: "XL" }).success).toBe(
      false
    );
  });

  it("parseJudgeOutput keeps valid judgments when one is malformed; tolerates <think> and fences", () => {
    const line = { id: "task.1", svc: "standard", effort: "M", ev: "task.1" };
    const text = `<think>hmm</think>\n\`\`\`json\n${JSON.stringify([line, { ...line, id: "task.2", effort: "XL" }])}\n\`\`\``;
    const out = parseJudgeOutput(text);
    expect(out.judgments.map((j) => j.itemId)).toEqual(["task.1"]);
    expect(out.invalid.length).toBe(1);
    expect(parseJudgeOutput("nope").judgments).toEqual([]);
  });
});

describe("policy (POLICY_FROM_TRIGGER)", () => {
  const policy = {
    policyVersion: "v5.0",
    applyMode: "write",
    // Pre-v5 fields the schedule may still send: caps and objectives are no longer policy.
    p0Max: 3,
    objectives: ["dao-goal-a"],
  };
  const block = (v: unknown) =>
    `PRIORITIZE\n\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;

  it("reads the schedule-appended policy block; ignores applyMode (PROPOSE_ONLY)", () => {
    const out = policyFromTrigger(block({ workPrioritization: policy }));
    expect(out.policy).toEqual({ policyVersion: "v5.0" });
    expect(out.fullReview).toBe(false);
  });

  it("FULL_REVIEW_ON_REQUEST: fullReview: true beside the policy", () => {
    expect(
      policyFromTrigger(block({ workPrioritization: policy, fullReview: true }))
        .fullReview
    ).toBe(true);
  });

  it("POLICY_REQUIRED: an absent or version-less policy ⇒ null", () => {
    expect(policyFromTrigger("PRIORITIZE").policy).toBeNull();
    expect(
      policyFromTrigger(block({ workPrioritization: { p0Max: 3 } })).policy
    ).toBeNull();
  });
});

describe("parseGoals (core__goal_list result)", () => {
  it("keeps goal-* rows with their id, title and statement", () => {
    expect(
      parseGoals({
        goals: [
          {
            id: "goal-a",
            title: "Goal: a",
            evaluateAt: null,
            content: "KPI x",
          },
          { id: "dao-goal-legacy", title: "Goal: legacy", content: "c" },
        ],
      })
    ).toEqual([{ id: "goal-a", title: "Goal: a", content: "KPI x" }]);
    expect(parseGoals({})).toEqual([]);
  });
});

describe("context", () => {
  it("snapshot id is order-independent and changes with any revision", () => {
    const a = [item("task.1"), item("task.2")];
    expect(computeSnapshotId(a)).toBe(computeSnapshotId([...a].reverse()));
    expect(computeSnapshotId(a)).not.toBe(
      computeSnapshotId([item("task.1"), item("task.2", { revision: 2 })])
    );
  });

  it("dedupes repeated items (higher revision wins), finds cycles and duplicate titles", () => {
    expect(
      dedupeWorkItems([
        item("a", { revision: 1 }),
        item("a", { revision: 3 }),
      ])[0]?.revision
    ).toBe(3);
    expect(
      findBlockerCycles([
        item("a", { blockedBy: "b" }),
        item("b", { blockedBy: "a" }),
      ]).map((c) => [...c].sort())
    ).toEqual([["a", "b"]]);
    expect(
      findDuplicateTitleGroups([
        item("bug.1", { title: "Same!" }),
        item("bug.2", { title: "same" }),
      ])
    ).toEqual([["bug.1", "bug.2"]]);
  });
});

describe("guards", () => {
  it("CONTEXT_BEFORE_JUDGMENT", () => {
    const ctx = buildGatheredContext({
      now: NOW.toISOString(),
      workItems: [item("a")],
      entries: [],
    });
    expect(hasHubContext(ctx.contextConsumed)).toBe(false);
  });

  it("EDO domain follows the first approved objective, then knowledge, then strategy", () => {
    expect(
      selectEdoDomain(
        ["dao-goal-a"],
        [
          entry("k", "knowledge", "meta"),
          entry("dao-goal-a", "edo", "operator"),
        ]
      )
    ).toBe("operator");
    expect(
      selectEdoDomain(["missing"], [entry("k", "knowledge", "meta")])
    ).toBe("meta");
    expect(selectEdoDomain([], [])).toBe("strategy");
  });
});

describe("TOLERANT_PARSING (replay-observed failure modes)", () => {
  const compact =
    '{"id":"bug.5001","impact":{"dao-goal-a":3},"svc":"standard","effort":"M","harmDays":3,"whyNow":"IO saturation","harm":"API down","ev":"bug.5001"}';

  it("parses the compact JSON-lines format, one judgment per line", () => {
    const out = parseJudgeOutput(
      `${compact}\n${compact.replaceAll("bug.5001", "bug.5002")}`
    );
    expect(
      out.judgments.map((j) => [
        j.itemId,
        j.serviceClass,
        j.harmIfWait.withinDays,
      ])
    ).toEqual([
      ["bug.5001", "standard", 3],
      ["bug.5002", "standard", 3],
    ]);
  });

  it("tolerates the null harm / harmDays the model emitted in 27/54 replayed lines", () => {
    const j = normalizeJudgment({
      id: "bug.5000",
      svc: "intangible",
      effort: "S",
      whyNow: "w",
      harm: null,
      harmDays: null,
    });
    expect(typeof j === "object" && j.harmIfWait).toEqual({
      text: "none",
      evidenceId: "bug.5000",
      withinDays: null,
    });
  });

  it("REGRESSION (live 20261021t0804): harm survives in both spellings gpt-oss-120b emits", () => {
    // Replayed from the live v4.2 decisions: work-prioritizer-20261021t0420-decision (p0 = bug.5002/5003/5005).
    const compact = parseJudgeOutput(
      '{"id":"bug.5005","impact":{"dao-goal-substrate-reliability":2},"svc":"standard","effort":"M","harmDays":1,"whyNow":"Session admission timeouts produce 503 errors under normal load.","harm":"Users experience 503 errors under normal load.","ev":"bug.5005"}'
    ).judgments[0];
    expect(compact?.harmIfWait).toEqual({
      text: "Users experience 503 errors under normal load.",
      evidenceId: "bug.5005",
      withinDays: 1,
    });
    const fullShape = parseJudgeOutput(
      '{"id":"bug.5002","impact":{"dao-goal-substrate-reliability":3},"svc":"standard","effort":"M","whyNow":{"text":"Current-position write starvation inflates I/O wait."},"harmIfWait":{"text":"High I/O wait degrades substrate performance.","withinDays":2},"ev":"bug.5002"}'
    ).judgments[0];
    expect(fullShape?.harmIfWait).toEqual({
      text: "High I/O wait degrades substrate performance.",
      evidenceId: "bug.5002",
      withinDays: 2,
    });
    expect(fullShape?.whyNow.text).toBe(
      "Current-position write starvation inflates I/O wait."
    );
    expect(
      normalizeJudgment({
        id: "t",
        svc: "standard",
        effort: "M",
        harmDays: "3",
      })
    ).toMatchObject({ harmIfWait: { withinDays: 3 } });
  });

  it("LENIENT_HARM_DAYS: numbers, the first integer in a string, and now-words", () => {
    for (const [v, want] of [
      [2, 2],
      [1.6, 2],
      [-1, null],
      ["1", 1],
      ["1 day", 1],
      ["2d", 2],
      ["≤7", 7],
      ["<=3 days", 3],
      ["<1", 0],
      ["<3", 2],
      ["48 hours", 2],
      ["2 weeks", 14],
      ["now", 0],
      ["Immediate", 0],
      ["ongoing", 0],
      ["today", 0],
      ["currently degrading", 0],
      ["none", null],
      ["unknown", null],
      [null, null],
      [undefined, null],
    ] as const)
      expect([v, parseHarmDays(v)]).toEqual([v, want]);
  });

  it("finds harm days under every key the model uses, top level or nested", () => {
    const days = (extra: Record<string, unknown>) => {
      const j = normalizeJudgment({
        id: "t",
        svc: "standard",
        effort: "M",
        ...extra,
      });
      return typeof j === "object" ? j.harmIfWait.withinDays : j;
    };
    expect(days({ harmDays: "1 day" })).toBe(1);
    expect(days({ withinDays: 2 })).toBe(2);
    expect(days({ harm_days: "3" })).toBe(3);
    expect(days({ days: "≤7" })).toBe(7);
    expect(
      days({ harmDays: null, harmIfWait: { text: "x", withinDays: "2d" } })
    ).toBe(2);
    expect(days({ harmIfWait: { text: "x", harmDays: "now" } })).toBe(0);
    expect(days({ harm: { text: "503s", days: "<1" } })).toBe(0);
    expect(days({ harm: "503s" })).toBeNull();
  });

  it("judgeItems records one bounded sample per batch with parse counts", async () => {
    const line = (id: string, harmDays: unknown) =>
      JSON.stringify({
        id,
        svc: "standard",
        effort: "M",
        harm: "x".repeat(500),
        harmDays,
      });
    const out = await judgeItems(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      3,
      async (batch) =>
        `<think>${"t".repeat(900)}</think>\n${batch.map((i, k) => line(i.id, k === 0 ? "1 day" : null)).join("\n")}`
    );
    expect(out.samples).toHaveLength(2);
    expect(out.samples[0]?.counts).toEqual({
      lines: 3,
      parsed: 3,
      withHarm: 3,
      withHarmDays: 1,
    });
    expect(out.samples[0]?.lines).toHaveLength(3);
    expect(out.samples[0]?.lines.every((l) => l.length <= 400)).toBe(true);
    expect(out.samples[1]?.counts.parsed).toBe(1);
  });

  it("normalizes enum case; a fixed_date without a date is standard", () => {
    expect(
      normalizeJudgment({ id: "t", svc: "EXPEDITE", effort: "s" })
    ).toMatchObject({ serviceClass: "expedite", effort: "S" });
    expect(
      normalizeJudgment({ id: "t", svc: "fixed_date", effort: "S" })
    ).toMatchObject({ serviceClass: "standard", fixedDate: null });
    expect(
      normalizeJudgment({
        id: "t",
        svc: "fixed_date",
        date: "2026-11-01",
        effort: "S",
      })
    ).toMatchObject({ serviceClass: "fixed_date", fixedDate: "2026-11-01" });
  });

  it("rejects unusable lines (no id, unknown enum, out-of-range impact)", () => {
    for (const bad of [
      { svc: "standard", effort: "M" },
      { id: "t", svc: "whenever", effort: "M" },
      { id: "t", svc: "standard", effort: "XXL" },
      { id: "t", svc: "standard", effort: "M", impact: { a: 9 } },
    ])
      expect(typeof normalizeJudgment(bad)).toBe("string");
  });

  it("a stray non-judgment line is reported unusable, never a judgment", () => {
    const out = parseJudgeOutput(
      '{"hypothesis":{"title":"t"}}\n{"id":"x","svc":"standard","effort":"M"}'
    );
    expect(out.judgments.map((j) => j.itemId)).toEqual(["x"]);
    expect(out.invalid).toEqual(["missing id"]);
  });
});
