// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/graphs/work-prioritizer/guards`
 * Purpose: Unit tests for the v4 judge/hypothesis guards, policy parsing, context derivation, and schemas.
 * Scope: Pure-function tests with fixtures; does not invoke an LLM, tools, or the graph.
 * Invariants: CONTEXT_BEFORE_JUDGMENT, JUDGMENT_COVERAGE, HYPOTHESES_DECIDABLE, POLICY_FROM_TRIGGER, ENUMS_NOT_FLOATS.
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
  guardHypothesisProposals,
  guardJudgments,
  guardRunContext,
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
    expect(out.ok && out.judgments.map((j) => j.itemId)).toEqual(["task.1"]);
    expect(out.ok && out.invalid.length).toBe(1);
    expect(parseJudgeOutput("nope").ok).toBe(false);
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
    hypothesesPerDay: 3,
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
      toolErrors: [],
    });
    expect(guardRunContext(ctx.contextConsumed)?.reason).toBe("empty_context");
  });

  it("JUDGMENT_COVERAGE: unknown, duplicate, and missing are reported", () => {
    const j = ItemJudgmentSchema.parse(J);
    const out = guardJudgments(
      [j, j, { ...j, itemId: "task.ghost" }],
      ["task.1", "task.2"]
    );
    expect([...out.byId.keys()]).toEqual(["task.1"]);
    expect(out.missing).toEqual(["task.2"]);
    expect(out.violations.map((v) => v.reason).sort()).toEqual([
      "judgment_duplicate",
      "judgment_missing",
      "judgment_unknown_item",
    ]);
  });

  it("HYPOTHESES_DECIDABLE: needs a snapshot item + hub citation; deadline normalized; daily cap", () => {
    const h = (title: string, o: Record<string, unknown> = {}) => ({
      title,
      prediction: "p",
      observationSource: "anything",
      predicate: {
        itemId: "task.1",
        field: "status" as const,
        equals: "done" as const,
        by: "2026-10-27T00:00:00.000Z",
      },
      citations: ["dao-goal-a"],
      ...o,
    });
    const out = guardHypothesisProposals(
      [
        h("unknown-item", {
          predicate: {
            itemId: "task.ghost",
            field: "status",
            equals: "done",
            by: "",
          },
        }),
        h("ungrounded", { citations: ["task.1"] }),
        h("no-deadline", {
          predicate: {
            itemId: "task.1",
            field: "status",
            equals: "done",
            by: "",
          },
        }),
        h("ok"),
        h("over-cap"),
      ],
      {
        itemIds: new Set(["task.1"]),
        hubIds: new Set(["dao-goal-a"]),
        now: NOW,
        remainingToday: 2,
      }
    );
    expect(out.accepted.map((a) => a.title)).toEqual(["no-deadline", "ok"]);
    expect(out.accepted[0]?.predicate.by).toBe("2026-11-03T12:00:00.000Z");
    expect(out.accepted[0]?.observationSource).toBe("work_item:task.1");
    expect(out.violations.map((v) => v.reason)).toEqual([
      "hypothesis_unknown_item",
      "hypothesis_ungrounded",
      "hypothesis_evaluate_at_normalized",
      "hypothesis_daily_cap",
    ]);
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

describe("ROBUST_JUDGE_PARSING (replay-observed failure modes)", () => {
  const compact =
    '{"id":"bug.5001","impact":{"dao-goal-a":3},"svc":"standard","effort":"M","harmDays":3,"whyNow":"IO saturation","harm":"API down","ev":"bug.5001"}';

  it("parses the compact JSON-lines format, one judgment per line", () => {
    const out = parseJudgeOutput(
      `${compact}\n${compact.replace("bug.5001", "bug.5002").replace("bug.5001", "bug.5002")}`
    );
    expect(
      out.ok &&
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

  it("tolerates a null harm / null harmDays and a {text} whyNow", () => {
    const j = normalizeJudgment({
      id: "bug.5000",
      svc: "intangible",
      effort: "S",
      whyNow: { text: "w" },
      harm: null,
      harmDays: null,
    });
    expect(typeof j === "object" && j.harmIfWait).toEqual({
      text: "none",
      evidenceId: "bug.5000",
      withinDays: null,
    });
    expect(typeof j === "object" && j.whyNow.text).toBe("w");
  });

  it("normalizes enum case/synonyms, trims ids, coerces numbers, ignores extra fields", () => {
    const j = normalizeJudgment({
      id: " task.1 ",
      svc: "Fixed-Date",
      date: "2026-11-01",
      effort: "medium",
      impact: { "dao-goal-a": "2", "dao-goal-b": 9 },
      harmDays: "5",
      ev: ["k1"],
      extra: true,
    });
    expect(j).toMatchObject({
      itemId: "task.1",
      serviceClass: "fixed_date",
      fixedDate: "2026-11-01",
      effort: "M",
      impact: { "dao-goal-a": 2, "dao-goal-b": 3 },
      harmIfWait: { withinDays: 5, evidenceId: "k1" },
    });
    expect(
      normalizeJudgment({ id: "t", svc: "EXPEDITED", effort: "s" })
    ).toMatchObject({ serviceClass: "expedite", effort: "S" });
    expect(
      normalizeJudgment({ id: "t", svc: "fixed_date", effort: "S" })
    ).toMatchObject({ serviceClass: "standard", fixedDate: null });
  });

  it("rejects only unusable lines", () => {
    expect(typeof normalizeJudgment({ svc: "standard", effort: "M" })).toBe(
      "string"
    );
    expect(
      typeof normalizeJudgment({ id: "t", svc: "whenever", effort: "M" })
    ).toBe("string");
    expect(
      typeof normalizeJudgment({ id: "t", svc: "standard", effort: "XXL" })
    ).toBe("string");
  });

  it("collects an optional hypothesis line", () => {
    const h =
      '{"hypothesis":{"title":"t","prediction":"p","predicate":{"itemId":"bug.1","field":"status","equals":"done","by":"2026-11-01T00:00:00.000Z"},"citations":["k"]}}';
    const out = parseJudgeOutput(`${compact}\n${h}`);
    expect(out.ok && out.hypotheses).toHaveLength(1);
  });
});
