// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/evals/work-prioritizer/score`
 * Purpose: Pure grader for the mission-loop scores eval (story.5111 step 6a): model scores vs the hand-scored gold, cell agreement within ±tolerance, and the top-1 item by `rankScore`.
 * Scope: Pure functions over parsed scores; no IO, no model calls. Orchestration lives in run.ts.
 * Invariants:
 *   - AXES_ARE_THE_DESIGN: the six axis ids and their order are hub `work-item-scores-design`'s (goal, time, unblocks, ease, confidence, agent).
 *   - RANK_FROM_THE_PACKAGE: top-1 uses `rankScore` from `@cogni/work-items`, so the eval ranks exactly as every node does.
 *   - MISSING_IS_A_MISS: an item or axis the model did not score (or scored outside 0–5) counts as a cell outside tolerance, never as skipped.
 *   - PASS_IS_EVERY_RUN: the verdict passes only when every run meets both bars.
 * Side-effects: none
 * Links: evals/work-prioritizer/README.md, tests/evals/work-prioritizer-scores.score.test.ts
 * @public
 */

import { rankScore } from "@cogni/work-items";

export const AXES = [
  "goal",
  "time",
  "unblocks",
  "ease",
  "confidence",
  "agent",
] as const;
export type Axis = (typeof AXES)[number];

/** One score per axis, in AXES order; `null` = missing or invalid. */
export type Vector = readonly (number | null)[];

export interface GoldItem {
  id: string;
  scores: readonly number[];
}

export interface Gold {
  items: readonly GoldItem[];
}

export interface Thresholds {
  tolerance: number;
  minCellShare: number;
  requireTop1: boolean;
  gating: boolean;
}

export interface PredictedItem {
  id: string;
  vector: Vector;
  /** The raw `{axis: {v, ev}}` object, kept for the store-validity info row. */
  raw: Record<string, { v: number; ev?: string }>;
}

export interface RunScore {
  cells: number;
  within: number;
  cellShare: number;
  perAxis: Record<Axis, { within: number; total: number }>;
  goldTop1: string | undefined;
  predictedTop1: string | undefined;
  top1Match: boolean;
  pass: boolean;
}

const isScore = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5;

const asScores = (vector: Vector) =>
  Object.fromEntries(
    AXES.flatMap((axis, i) => {
      const v = vector[i];
      return v === null || v === undefined ? [] : [[axis, { v }]];
    })
  );

/** The item with the highest `rankScore`; ties keep the earlier item; undefined when none is rankable. */
export function top1(
  items: readonly { id: string; vector: Vector }[]
): string | undefined {
  let best: { id: string; rank: number } | undefined;
  for (const item of items) {
    const rank = rankScore(asScores(item.vector));
    if (rank === undefined) continue;
    if (!best || rank > best.rank) best = { id: item.id, rank };
  }
  return best?.id;
}

/** `rankScore` of one vector (undefined when an input axis is missing or 0). */
export function rankOf(vector: Vector): number | undefined {
  return rankScore(asScores(vector));
}

/**
 * Parse the model's reply: one JSON object `{ "<item id>": { "<axis>": { "v": n, "ev": "…" } | n } }`,
 * optionally wrapped in prose or a ``` fence. Returns one entry per requested id; unknown ids are dropped.
 */
export function parsePrediction(
  text: string,
  ids: readonly string[]
): PredictedItem[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let body: Record<string, unknown> = {};
  if (start > -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object")
        body = parsed as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  return ids.map((id) => {
    const entry = (body[id] ?? {}) as Record<string, unknown>;
    const raw: PredictedItem["raw"] = {};
    const vector = AXES.map((axis) => {
      const cell = entry[axis];
      const v =
        cell && typeof cell === "object" ? (cell as { v?: unknown }).v : cell;
      if (!isScore(v)) return null;
      const ev = (cell as { ev?: unknown } | undefined)?.ev;
      raw[axis] = { v, ...(typeof ev === "string" && ev && { ev }) };
      return v;
    });
    return { id, vector, raw };
  });
}

/** Grade one run against the gold. */
export function scoreRun(
  gold: Gold,
  predicted: readonly PredictedItem[],
  th: Thresholds
): RunScore {
  const perAxis = Object.fromEntries(
    AXES.map((a) => [a, { within: 0, total: 0 }])
  ) as Record<Axis, { within: number; total: number }>;
  let cells = 0;
  let within = 0;
  for (const g of gold.items) {
    const p = predicted.find((x) => x.id === g.id);
    AXES.forEach((axis, i) => {
      const want = g.scores[i] as number;
      const got = p?.vector[i];
      const ok =
        got !== null &&
        got !== undefined &&
        Math.abs(got - want) <= th.tolerance;
      cells++;
      perAxis[axis].total++;
      if (ok) {
        within++;
        perAxis[axis].within++;
      }
    });
  }
  const cellShare = cells ? within / cells : 0;
  const goldTop1 = top1(
    gold.items.map((g) => ({ id: g.id, vector: g.scores }))
  );
  const predictedTop1 = top1(
    gold.items.map((g) => ({
      id: g.id,
      vector: predicted.find((x) => x.id === g.id)?.vector ?? [],
    }))
  );
  const top1Match = goldTop1 !== undefined && goldTop1 === predictedTop1;
  return {
    cells,
    within,
    cellShare,
    perAxis,
    goldTop1,
    predictedTop1,
    top1Match,
    pass: cellShare >= th.minCellShare && (!th.requireTop1 || top1Match),
  };
}

/** PASS_IS_EVERY_RUN: the verdict over all runs. */
export function verdict(runs: readonly RunScore[]): {
  pass: boolean;
  meanCellShare: number;
  top1Matches: number;
} {
  return {
    pass: runs.length > 0 && runs.every((r) => r.pass),
    meanCellShare: runs.length
      ? runs.reduce((s, r) => s + r.cellShare, 0) / runs.length
      : 0,
    top1Matches: runs.filter((r) => r.top1Match).length,
  };
}

/** Split a prompt into ≤ max-char messages on line boundaries (the node chat route caps each message). */
export function chunkMessage(
  prompt: string,
  max: number | undefined
): string[] {
  if (!max || prompt.length <= max) return [prompt];
  const out: string[] = [];
  let current = "";
  for (const line of prompt.split("\n")) {
    for (let i = 0; i < Math.max(line.length, 1); i += max) {
      const piece = line.slice(i, i + max);
      if (current && current.length + 1 + piece.length > max) {
        out.push(current);
        current = piece;
      } else current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) out.push(current);
  return out;
}
