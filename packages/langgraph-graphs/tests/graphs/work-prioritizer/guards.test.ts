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
} from "../../../src/graphs/work-prioritizer/context";
import {
  hasHubContext,
  selectEdoDomain,
} from "../../../src/graphs/work-prioritizer/guards";
import { policyFromTrigger } from "../../../src/graphs/work-prioritizer/policy";
import {
  normalizeJudgment,
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
    policyVersion: "v4.0",
    p0Max: 3,
    p1Budget: 6,
    p2Budget: 12,
    objectives: ["dao-goal-a"],
    applyMode: "write",
  };
  const block = (v: unknown) =>
    `PRIORITIZE\n\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;

  it("reads the schedule-appended policy block; ignores applyMode (PROPOSE_ONLY)", () => {
    const out = policyFromTrigger(block({ workPrioritization: policy }));
    expect(out.policy?.objectives).toEqual(["dao-goal-a"]);
    expect(out.policy).not.toHaveProperty("applyMode");
    expect(out.fullReview).toBe(false);
  });

  it("FULL_REVIEW_ON_REQUEST: fullReview: true beside the policy", () => {
    expect(
      policyFromTrigger(block({ workPrioritization: policy, fullReview: true }))
        .fullReview
    ).toBe(true);
  });

  it("POLICY_REQUIRED: absent, invalid, or objective-less policy ⇒ null", () => {
    expect(policyFromTrigger("PRIORITIZE").policy).toBeNull();
    expect(
      policyFromTrigger(block({ workPrioritization: { p0Max: "x" } })).policy
    ).toBeNull();
    expect(
      policyFromTrigger(
        block({ workPrioritization: { ...policy, objectives: [] } })
      ).policy
    ).toBeNull();
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
