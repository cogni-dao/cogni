// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/evals/work-prioritizer-scores.score`
 * Purpose: Pins the mission-loop scores eval grader (story.5111 step 6a): ±1 cell agreement, the 80% bar, top-1 by the package rankScore, reply parsing, and that the agent prompt embeds the exact lines the eval sends.
 * Scope: Pure grader tests over hand-made predictions; does not call a node or an LLM.
 * Invariants: MISSING_IS_A_MISS, RANK_FROM_THE_PACKAGE, PASS_IS_EVERY_RUN, SCORES_LINES_ARE_SHARED.
 * Side-effects: none
 * Links: evals/work-prioritizer/score.ts, https://cognidao.org/knowledge/work-item-scores-design
 * @internal
 */

import { describe, expect, it } from "vitest";

import goldFile from "../../evals/work-prioritizer/gold.json";
import {
  AXES,
  chunkMessage,
  type Gold,
  type PredictedItem,
  parsePrediction,
  rankOf,
  scoreRun,
  type Thresholds,
  top1,
  verdict,
} from "../../evals/work-prioritizer/score";
import thresholdsFile from "../../evals/work-prioritizer/thresholds.json";
import {
  WORK_ITEM_SCORES_PROMPT_LINES,
  WORK_PRIORITIZER_SYSTEM_PROMPT,
} from "../../src/graphs/work-prioritizer/prompts";

const gold = goldFile as Gold;
const th = thresholdsFile as Thresholds;

const asPredicted = (
  rows: readonly { id: string; scores: readonly (number | null)[] }[]
): PredictedItem[] =>
  rows.map((r) => ({ id: r.id, vector: r.scores, raw: {} }));

describe("work-prioritizer scores eval grader", () => {
  it("holds the 5 hand-scored items with 6 axes each, and story.5107 is gold top-1", () => {
    expect(gold.items.map((g) => g.id)).toEqual([
      "story.5107",
      "story.5108",
      "story.5068",
      "bug.5287",
      "story.5095",
    ]);
    for (const g of gold.items) expect(g.scores).toHaveLength(AXES.length);
    expect(top1(gold.items.map((g) => ({ id: g.id, vector: g.scores })))).toBe(
      "story.5107"
    );
    expect(rankOf([5, 5, 5, 5, 5, 1])).toBe(15);
  });

  it("passes gold against itself", () => {
    const s = scoreRun(gold, asPredicted(gold.items), th);
    expect(s).toMatchObject({
      cells: 30,
      within: 30,
      cellShare: 1,
      top1Match: true,
      pass: true,
    });
  });

  it("counts a cell off by 1 as within and off by 2 as a miss", () => {
    const shifted = gold.items.map((g) => ({
      id: g.id,
      scores: g.scores.map((v, i) => (i === 0 ? Math.max(0, v - 1) : v)),
    }));
    expect(scoreRun(gold, asPredicted(shifted), th).within).toBe(30);
    const far = gold.items.map((g, n) => ({
      id: g.id,
      scores: g.scores.map((v, i) => (n === 1 && i === 5 ? v - 2 : v)),
    }));
    const s = scoreRun(gold, asPredicted(far), th);
    expect(s.within).toBe(29);
    expect(s.perAxis.agent).toEqual({ within: 4, total: 5 });
  });

  it("fails below 80% of cells (7 misses = 76.7%) even with the right top-1", () => {
    const misses = new Set(["1:5", "2:5", "3:5", "4:5", "1:1", "2:1", "3:1"]);
    const rows = gold.items.map((g, n) => ({
      id: g.id,
      scores: g.scores.map((v, i) =>
        misses.has(`${n}:${i}`) ? (v >= 3 ? v - 3 : v + 3) : v
      ),
    }));
    const s = scoreRun(gold, asPredicted(rows), th);
    expect(s.within).toBe(23);
    expect(s.top1Match).toBe(true);
    expect(s.pass).toBe(false);
  });

  it("fails on a top-1 mismatch even when every cell is within ±1", () => {
    const rows = gold.items.map((g) => ({
      id: g.id,
      scores:
        g.id === "story.5107"
          ? [4, 4, 4, 4, 4, 1]
          : g.id === "story.5108"
            ? [5, 3, 5, 4, 5, 4]
            : g.scores,
    }));
    const s = scoreRun(gold, asPredicted(rows), th);
    expect(s.within).toBe(30);
    expect(s.predictedTop1).toBe("story.5108");
    expect(s.pass).toBe(false);
  });

  it("counts a missing item as 6 misses (MISSING_IS_A_MISS)", () => {
    const rows = gold.items.filter((g) => g.id !== "story.5095");
    const s = scoreRun(gold, asPredicted(rows), th);
    expect(s.within).toBe(24);
    expect(s.cellShare).toBeCloseTo(0.8);
    expect(s.pass).toBe(true);
  });

  it("passes the verdict only when every run passes", () => {
    const good = scoreRun(gold, asPredicted(gold.items), th);
    const bad = scoreRun(gold, [], th);
    expect(verdict([good, good]).pass).toBe(true);
    expect(verdict([good, bad])).toMatchObject({ pass: false, top1Matches: 1 });
    expect(verdict([]).pass).toBe(false);
  });

  it("parses a fenced reply with {v, ev} cells or bare numbers, rejecting out-of-range values", () => {
    const reply = [
      "Here you go:",
      "```json",
      JSON.stringify({
        "story.5107": {
          goal: { v: 5, ev: "https://cognidao.org/work/items/story.5107" },
          time: 4,
          unblocks: { v: 9 },
          ease: { v: 2.5 },
          confidence: { v: 3 },
        },
        "task.9999": { goal: 1 },
      }),
      "```",
    ].join("\n");
    const [p, missing] = parsePrediction(reply, ["story.5107", "story.5108"]);
    expect(p?.vector).toEqual([5, 4, null, null, 3, null]);
    expect(p?.raw.goal).toEqual({
      v: 5,
      ev: "https://cognidao.org/work/items/story.5107",
    });
    expect(missing?.vector).toEqual([null, null, null, null, null, null]);
    expect(parsePrediction("no json", ["story.5107"])[0]?.vector).toEqual(
      Array(6).fill(null)
    );
  });

  it("chunks long prompts into ≤ max-char messages without losing text", () => {
    const text = Array.from(
      { length: 40 },
      (_, i) => `line ${i} ${"x".repeat(90)}`
    ).join("\n");
    const chunks = chunkMessage(text, 500);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
    expect(chunks.join("\n")).toBe(text);
    expect(chunkMessage("short", 500)).toEqual(["short"]);
  });

  it("sends the exact scoring lines the agent's system prompt embeds (SCORES_LINES_ARE_SHARED)", () => {
    expect(WORK_PRIORITIZER_SYSTEM_PROMPT).toContain(
      WORK_ITEM_SCORES_PROMPT_LINES
    );
    for (const axis of AXES)
      expect(WORK_ITEM_SCORES_PROMPT_LINES).toContain(axis);
    expect(WORK_ITEM_SCORES_PROMPT_LINES.split("\n")).toHaveLength(2);
  });
});
