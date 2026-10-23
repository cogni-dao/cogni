// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/evals/guidance-routing.score`
 * Purpose: Pins the guidance-routing eval scorer: micro recall@k overall and for rules, the mean of runs, pick parsing, and the design's decision table.
 * Scope: Pure scorer tests over hand-made selections; does not call a node or an LLM.
 * Invariants: SCORER_IS_PURE; DECISION_TABLE_IS_EXHAUSTIVE (every measured outcome maps to exactly one row).
 * Side-effects: none
 * Links: evals/guidance-routing/score.ts, https://cognidao.org/knowledge/guidance-routing-design
 * @internal
 */

import { describe, expect, it } from "vitest";

import goldFile from "../../evals/guidance-routing/gold.json";
import {
  bm25Rank,
  ceiling,
  chunkMessage,
  decide,
  type Gold,
  meanOfRuns,
  parsePicks,
  recallAt,
  scoreRun,
  type Thresholds,
  toolOutputFromSse,
} from "../../evals/guidance-routing/score";
import thresholdsFile from "../../evals/guidance-routing/thresholds.json";

const gold: Gold = {
  tasks: [
    {
      id: "task.1",
      labels: [
        { id: "a", entryType: "rule" },
        { id: "b", entryType: "skill" },
      ],
    },
    { id: "task.2", labels: [{ id: "c", entryType: "rule" }] },
  ],
};

const thresholds = thresholdsFile as unknown as Thresholds;

describe("recallAt — micro recall over every label", () => {
  const selections = [
    // b sits at rank 6: inside @10, outside @5.
    { taskId: "task.1", picks: ["x", "a", "y", "z", "w", "b"] },
    { taskId: "task.2", picks: [] },
  ];

  it("counts hits in the top k against all labels", () => {
    expect(recallAt(gold, selections, 5)).toEqual({
      hits: 1,
      total: 3,
      recall: 1 / 3,
    });
    expect(recallAt(gold, selections, 10)).toEqual({
      hits: 2,
      total: 3,
      recall: 2 / 3,
    });
    expect(recallAt(gold, selections, 1)).toEqual({
      hits: 0,
      total: 3,
      recall: 0,
    });
  });

  it("restricts to rule labels for rules@k", () => {
    expect(
      recallAt(gold, selections, 5, (l) => l.entryType === "rule")
    ).toEqual({ hits: 1, total: 2, recall: 0.5 });
  });

  it("never double-counts a repeated pick, and a missing selection scores 0", () => {
    expect(
      recallAt(gold, [{ taskId: "task.1", picks: ["a", "a", "a"] }], 5)
    ).toEqual({ hits: 1, total: 3, recall: 1 / 3 });
  });
});

describe("ceiling — the recall any selector could reach from the rows it is shown", () => {
  it("counts labels present in the rows, overall and for rules", () => {
    expect(ceiling(gold, ["a", "b", "zzz"])).toEqual({
      all: { hits: 2, total: 3, recall: 2 / 3 },
      rules: { hits: 1, total: 2, recall: 0.5 },
    });
    expect(ceiling(gold, []).all.recall).toBe(0);
  });
});

describe("scoreRun + meanOfRuns", () => {
  it("scores recall@3/@5/@10 and rules@5 for one run", () => {
    const run = scoreRun(gold, [
      { taskId: "task.1", picks: ["a", "b"] },
      { taskId: "task.2", picks: ["q", "r", "s", "t", "u", "c"] },
    ]);
    expect(run.recallAt3).toBeCloseTo(2 / 3);
    expect(run.recallAt5).toBeCloseTo(2 / 3);
    expect(run.recallAt10).toBeCloseTo(1);
    expect(run.rulesAt5).toBeCloseTo(1 / 2);
  });

  it("averages each metric across runs and refuses fewer than minRuns", () => {
    const r = (x: number) => ({
      recallAt3: x,
      recallAt5: x,
      recallAt10: x,
      rulesAt5: x,
    });
    expect(meanOfRuns([r(0.8), r(0.9)], 2).recallAt5).toBeCloseTo(0.85);
    expect(() => meanOfRuns([r(0.9)], 2)).toThrow(/at least 2 runs/);
  });
});

describe("parsePicks — the selector's ranked ids", () => {
  const known = new Set(["a", "b", "c"]);

  it("reads the first JSON array, keeps known ids in order, dedupes, and caps", () => {
    expect(
      parsePicks('Here you go: ["b", "zzz", "a", "b"] 🌟', known, 10)
    ).toEqual(["b", "a"]);
    expect(parsePicks('["a","b","c"]', known, 2)).toEqual(["a", "b"]);
  });

  it("returns [] when the reply carries no parseable array", () => {
    expect(parsePicks("no idea", known, 10)).toEqual([]);
    expect(parsePicks("[not json", known, 10)).toEqual([]);
  });
});

describe("chunkMessage — split a prompt under a per-message character cap", () => {
  it("returns the prompt whole when no cap is set or it fits", () => {
    expect(chunkMessage("a\nb", undefined)).toEqual(["a\nb"]);
    expect(chunkMessage("a\nb", 10)).toEqual(["a\nb"]);
  });

  it("splits on line boundaries, keeps order, and loses no characters", () => {
    const prompt = ["intro", "row-1 aaaa", "row-2 bbbb", "ask"].join("\n");
    const chunks = chunkMessage(prompt, 12);
    expect(chunks).toEqual(["intro", "row-1 aaaa", "row-2 bbbb", "ask"]);
    expect(chunks.join("\n")).toBe(prompt);
  });

  it("hard-splits a single line longer than the cap", () => {
    const chunks = chunkMessage("x".repeat(25), 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    for (const c of chunkMessage(`${"y".repeat(9)}\n${"z".repeat(30)}`, 10))
      expect(c.length).toBeLessThanOrEqual(10);
  });
});

describe("toolOutputFromSse — the real core__knowledge_index result from an ai/chat stream", () => {
  const sse = [
    'data: {"type":"tool-input-start","toolCallId":"k1","toolName":"core__knowledge_search"}',
    'data: {"type":"tool-output-available","toolCallId":"k1","output":{"results":[]}}',
    'data: {"type":"tool-input-start","toolCallId":"i1","toolName":"core__knowledge_index"}',
    'data: {"type":"tool-output-available","toolCallId":"i1","output":{"entries":[{"id":"a","domain":"method","entryType":"rule","useWhen":"w"}],"truncated":false,"omittedDomains":[]}}',
    'data: {"type":"text-delta","id":"t","delta":"DONE"}',
    "data: [DONE]",
  ].join("\n\n");

  it("returns the output of the named tool's call, ignoring other tools", () => {
    expect(toolOutputFromSse(sse, "core__knowledge_index")).toEqual({
      entries: [{ id: "a", domain: "method", entryType: "rule", useWhen: "w" }],
      truncated: false,
      omittedDomains: [],
    });
  });

  it("returns null when the tool was never called", () => {
    expect(toolOutputFromSse(sse, "core__goal_list")).toBeNull();
    expect(toolOutputFromSse("not sse", "core__knowledge_index")).toBeNull();
  });
});

describe("bm25Rank — the row-7 lexical prefilter", () => {
  const docs = [
    { id: "postgres-crash-observability", text: "a shared postgres crashed" },
    { id: "akash-lease-guide", text: "an akash lease needs recovery" },
    { id: "generic-guide", text: "any task at all" },
  ];

  it("ranks documents sharing rarer query terms first and drops zero scores", () => {
    expect(bm25Rank("postgres crashed in prod", docs, 10)).toEqual([
      "postgres-crash-observability",
    ]);
    expect(bm25Rank("akash lease lost; postgres fine", docs, 10)).toEqual([
      "akash-lease-guide",
      "postgres-crash-observability",
    ]);
  });

  it("tokenizes ids on hyphens and caps at k", () => {
    expect(bm25Rank("observability", docs, 10)).toEqual([
      "postgres-crash-observability",
    ]);
    expect(bm25Rank("guide", docs, 1)).toHaveLength(1);
  });
});

describe("decide — the design's decision table", () => {
  const A = (recallAt5: number, rulesAt5: number) => ({ recallAt5, rulesAt5 });
  const small = 50_800;
  const cases: [string, Parameters<typeof decide>[0], number][] = [
    [
      "row 0: bundle over budget skips A",
      {
        bundleBytes: 70_000,
        A: A(0.95, 0.95),
        T: { recallAt10: 0.9 },
      },
      5,
    ],
    ["row 1: ship A", { bundleBytes: small, A: A(0.88, 0.79) }, 1],
    ["row 2: A with weak rules", { bundleBytes: small, A: A(0.85, 0.6) }, 2],
    ["row 3: A in the patch band", { bundleBytes: small, A: A(0.72, 0.9) }, 3],
    ["row 4: A below the floor", { bundleBytes: small, A: A(0.5, 0.9) }, 4],
    ["row 5: ship T", { bundleBytes: 70_000, T: { recallAt10: 0.86 } }, 5],
    [
      "row 6: T in the patch band",
      { bundleBytes: 70_000, T: { recallAt10: 0.82 } },
      6,
    ],
    [
      "row 7: T below the floor",
      { bundleBytes: 70_000, T: { recallAt10: 0.7 } },
      7,
    ],
  ];
  for (const [name, input, row] of cases) {
    it(name, () => {
      expect(decide(input, thresholds).row).toBe(row);
    });
  }

  it("row 7 needs BM25; BM25 at the bar ships it", () => {
    const T = { recallAt10: 0.49 };
    const Afail = { recallAt5: 0.6, rulesAt5: 0.63 };
    expect(
      decide({ bundleBytes: small, A: Afail, T }, thresholds)
    ).toMatchObject({
      row: 7,
      needs: "BM25",
    });
    expect(
      decide(
        { bundleBytes: small, A: Afail, T, BM25: { recallAt10: 0.9 } },
        thresholds
      )
    ).toMatchObject({ row: 7, ship: true });
  });

  it("row 8: BM25 below the bar names the best-measured stopgap, excluding A past the budget", () => {
    const measured = {
      A: { recallAt5: 0.6, rulesAt5: 0.63, recallAt10: 0.745 },
      T: { recallAt10: 0.49 },
      BM25: { recallAt10: 0.6 },
    };
    expect(
      decide({ bundleBytes: small, ...measured }, thresholds)
    ).toMatchObject({ row: 8, ship: false, stopgap: "A" });
    expect(
      decide({ bundleBytes: 70_000, ...measured }, thresholds)
    ).toMatchObject({ row: 8, stopgap: "BM25" });
  });

  it("row 4 names the mechanism still to measure; row 1 needs nothing", () => {
    expect(
      decide({ bundleBytes: small, A: A(0.5, 0.9) }, thresholds).needs
    ).toBe("T+method");
    expect(
      decide({ bundleBytes: small, A: A(0.88, 0.79) }, thresholds).needs
    ).toBeUndefined();
  });

  it("ships only on rows 1 and 5", () => {
    expect(
      decide({ bundleBytes: small, A: A(0.88, 0.79) }, thresholds).ship
    ).toBe(true);
    expect(
      decide({ bundleBytes: small, A: A(0.85, 0.6) }, thresholds).ship
    ).toBe(false);
  });

  it("is inconclusive when the mechanism the row needs was not measured", () => {
    expect(
      decide({ bundleBytes: 70_000, A: A(0.9, 0.9) }, thresholds).row
    ).toBe(null);
    expect(decide({ bundleBytes: small }, thresholds).row).toBe(null);
  });
});

describe("committed gold set and thresholds", () => {
  it("holds the design's 18 tasks and 55 labels with their type mix", () => {
    const g = goldFile as unknown as Gold;
    expect(g.tasks).toHaveLength(18);
    const labels = g.tasks.flatMap((t) => t.labels);
    expect(labels).toHaveLength(55);
    const count = (t: string) => labels.filter((l) => l.entryType === t).length;
    expect([count("rule"), count("skill"), count("guide")]).toEqual([
      19, 15, 12,
    ]);
    expect([count("reference"), count("design"), count("decision")]).toEqual([
      6, 2, 1,
    ]);
  });

  it("pins the bar: recall@5 0.80, rules@5 0.75, mean of 2 runs, 64 KiB budget", () => {
    expect(thresholds.A.recallAt5).toBe(0.8);
    expect(thresholds.A.rulesAt5).toBe(0.75);
    expect(thresholds.minRuns).toBe(2);
    expect(thresholds.bundleBudgetBytes).toBe(65_536);
  });
});
