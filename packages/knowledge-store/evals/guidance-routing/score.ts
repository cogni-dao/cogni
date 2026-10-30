// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/evals/guidance-routing/score`
 * Purpose: Pure scorer for the guidance-routing eval: micro recall@k overall and for rules, the mean of selector runs, pick parsing, and the design's decision table.
 * Scope: Pure functions over the gold set, ranked selections and thresholds; does not perform IO.
 * Invariants:
 *   - SCORER_IS_PURE: same input, same score; pinned by tests/evals/guidance-routing.score.test.ts.
 *   - MICRO_RECALL: recall@k = labels found in the top k picks ÷ all labels, summed over tasks.
 *   - MEAN_OF_RUNS: every threshold compares the mean of at least `minRuns` runs.
 *   - DECISION_TABLE_IS_EXHAUSTIVE: every measured outcome maps to exactly one row; row 0 (bundle over budget) takes precedence.
 * Side-effects: none
 * Links: evals/guidance-routing/README.md, run.ts, https://cognidao.org/knowledge/guidance-routing-design
 * @public
 */

export interface GoldLabel {
  readonly id: string;
  readonly entryType: string;
}

export interface GoldTask {
  readonly id: string;
  readonly labels: readonly GoldLabel[];
}

export interface Gold {
  readonly tasks: readonly GoldTask[];
}

/** One selector run's ranked picks for one task, most governing first. */
export interface Selection {
  readonly taskId: string;
  readonly picks: readonly string[];
}

export interface RecallResult {
  readonly hits: number;
  readonly total: number;
  readonly recall: number;
}

export interface RunScore {
  readonly recallAt3: number;
  readonly recallAt5: number;
  readonly recallAt10: number;
  readonly rulesAt5: number;
}

export interface Thresholds {
  readonly minRuns: number;
  readonly maxPicks: number;
  readonly bundleBudgetBytes: number;
  readonly A: {
    readonly recallAt5: number;
    readonly rulesAt5: number;
    readonly patchFloorAt5: number;
  };
  readonly T: { readonly recallAt10: number; readonly patchFloorAt10: number };
}

/** MICRO_RECALL over the labels `keep` admits (all labels by default). */
export function recallAt(
  gold: Gold,
  selections: readonly Selection[],
  k: number,
  keep: (label: GoldLabel) => boolean = () => true
): RecallResult {
  const picksBy = new Map(selections.map((s) => [s.taskId, s.picks]));
  let hits = 0;
  let total = 0;
  for (const task of gold.tasks) {
    const top = new Set((picksBy.get(task.id) ?? []).slice(0, k));
    for (const label of task.labels) {
      if (!keep(label)) continue;
      total += 1;
      if (top.has(label.id)) hits += 1;
    }
  }
  return { hits, total, recall: total === 0 ? 0 : hits / total };
}

const isRule = (l: GoldLabel) => l.entryType === "rule";

/**
 * The reachable ceiling: the share of labels present in the rows a mechanism
 * shows the selector. No model call; a selector can never beat it.
 */
export function ceiling(
  gold: Gold,
  rowIds: readonly string[]
): { all: RecallResult; rules: RecallResult } {
  const everything = [...new Set(rowIds)];
  const shown = gold.tasks.map((t) => ({ taskId: t.id, picks: everything }));
  const k = Number.POSITIVE_INFINITY;
  return {
    all: recallAt(gold, shown, k),
    rules: recallAt(gold, shown, k, isRule),
  };
}

/** One run's recall@3/@5/@10 and rules@5. */
export function scoreRun(
  gold: Gold,
  selections: readonly Selection[]
): RunScore {
  return {
    recallAt3: recallAt(gold, selections, 3).recall,
    recallAt5: recallAt(gold, selections, 5).recall,
    recallAt10: recallAt(gold, selections, 10).recall,
    rulesAt5: recallAt(gold, selections, 5, isRule).recall,
  };
}

/** MEAN_OF_RUNS: per-metric mean; throws below `minRuns` (selectors are non-deterministic). */
export function meanOfRuns(
  runs: readonly RunScore[],
  minRuns: number
): RunScore {
  if (runs.length < minRuns)
    throw new Error(
      `need at least ${minRuns} runs to score, got ${runs.length}`
    );
  const mean = (pick: (r: RunScore) => number) =>
    runs.reduce((sum, r) => sum + pick(r), 0) / runs.length;
  return {
    recallAt3: mean((r) => r.recallAt3),
    recallAt5: mean((r) => r.recallAt5),
    recallAt10: mean((r) => r.recallAt10),
    rulesAt5: mean((r) => r.rulesAt5),
  };
}

/**
 * The selector's ranked ids: the first JSON array in the reply, restricted to
 * ids the selector was shown, deduped, capped at `max`. Unparseable → [].
 */
export function parsePicks(
  reply: string,
  known: ReadonlySet<string>,
  max: number
): string[] {
  const start = reply.indexOf("[");
  const end = reply.indexOf("]", start);
  if (start < 0 || end < 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const v of parsed) {
    const id = typeof v === "string" ? v.replace(/`/g, "").trim() : "";
    if (!known.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Split a prompt into consecutive messages of at most `max` characters, packing
 * whole lines (a line longer than `max` is hard-split). Joining line-packed
 * chunks with "\n" restores the prompt. No cap, or a prompt that fits → [prompt].
 */
export function chunkMessage(
  prompt: string,
  max: number | undefined
): string[] {
  if (!max || prompt.length <= max) return [prompt];
  const out: string[] = [];
  let current: string | null = null;
  for (const line of prompt.split("\n")) {
    const pieces: string[] = [];
    if (line.length <= max) pieces.push(line);
    else
      for (let i = 0; i < line.length; i += max)
        pieces.push(line.slice(i, i + max));
    for (const piece of pieces) {
      if (current === null) current = piece;
      else if (current.length + 1 + piece.length <= max)
        current = `${current}\n${piece}`;
      else {
        out.push(current);
        current = piece;
      }
    }
  }
  if (current !== null) out.push(current);
  return out;
}

/**
 * TOOL_PATH_IS_REAL: the output of the first call to `toolName` in an
 * `/api/v1/ai/chat` AI SDK stream (`tool-input-start` names the tool,
 * `tool-output-available` carries its result). Null when it was never called.
 */
export function toolOutputFromSse(sse: string, toolName: string): unknown {
  const ids = new Set<string>();
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let event: {
      type?: string;
      toolCallId?: string;
      toolName?: string;
      output?: unknown;
    };
    try {
      event = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    if (
      event.type === "tool-input-start" &&
      event.toolName === toolName &&
      event.toolCallId
    )
      ids.add(event.toolCallId);
    if (
      event.type === "tool-output-available" &&
      event.toolCallId &&
      ids.has(event.toolCallId)
    )
      return event.output ?? null;
  }
  return null;
}

const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);

/**
 * BM25 (k1 1.2, b 0.75) over each document's id (split on hyphens) plus its
 * text: the ids of the top `k` documents with a positive score, best first.
 * The row-7 prefilter ("BM25 top-50 → select").
 */
export function bm25Rank(
  query: string,
  docs: readonly { id: string; text: string }[],
  k: number
): string[] {
  const k1 = 1.2;
  const b = 0.75;
  const bags = docs.map((d) => tokens(`${d.id} ${d.text}`));
  const avg = bags.reduce((n, t) => n + t.length, 0) / Math.max(bags.length, 1);
  const df = new Map<string, number>();
  for (const bag of bags)
    for (const term of new Set(bag)) df.set(term, (df.get(term) ?? 0) + 1);
  const terms = [...new Set(tokens(query))];
  const scored = docs.map((d, i) => {
    const bag = bags[i] ?? [];
    let score = 0;
    for (const term of terms) {
      const n = df.get(term) ?? 0;
      if (n === 0) continue;
      const tf = bag.filter((t) => t === term).length;
      if (tf === 0) continue;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score +=
        (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * bag.length) / avg));
    }
    return { id: d.id, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, k)
    .map((s) => s.id);
}

export interface DecisionInput {
  /** The whole rendered bundle, UTF-8 bytes. */
  readonly bundleBytes: number;
  /** Approach A (whole governing index in context), mean of runs. */
  readonly A?: {
    readonly recallAt5: number;
    readonly rulesAt5: number;
    /** Used only to pick the row-8 stopgap. */
    readonly recallAt10?: number;
  };
  /** Approach T plus the `method` shelf, mean of runs. */
  readonly T?: { readonly recallAt10: number };
  /** BM25 top-50 then select (row 7), mean of runs. */
  readonly BM25?: { readonly recallAt10: number };
}

export interface Decision {
  /** Decision-table row, or null when the row it needs was not measured. */
  readonly row: number | null;
  readonly ship: boolean;
  readonly action: string;
  /** The mechanism the row says to measure next, when the table cannot conclude without it. */
  readonly needs?: "T+method" | "BM25";
  /** Row 8: the best-measured mechanism to ship as a stopgap while the embeddings spike runs. */
  readonly stopgap?: "A" | "T+method" | "BM25";
}

/** DECISION_TABLE_IS_EXHAUSTIVE: the guidance-routing-design table, rows 0–7 (row 8 needs BM25). */
export function decide(input: DecisionInput, th: Thresholds): Decision {
  const overBudget = input.bundleBytes > th.bundleBudgetBytes;
  if (!overBudget) {
    if (!input.A)
      return {
        row: null,
        ship: false,
        action: "Bundle within budget: measure A first.",
      };
    const { recallAt5: a, rulesAt5: rules } = input.A;
    if (a >= th.A.recallAt5 && rules >= th.A.rulesAt5)
      return { row: 1, ship: true, action: "Ship A." };
    if (a >= th.A.recallAt5)
      return {
        row: 2,
        ship: false,
        action:
          "Ship A. Patch the useWhen of missed rules on one half of the gold tasks, then re-score rules@5 on the held-out half; below the bar, go to row 5.",
      };
    if (a >= th.A.patchFloorAt5)
      return {
        row: 3,
        ship: false,
        action:
          "Ship A and run the patch pass. Re-score the held-out half: keep A at the bar, apply row 2 if only rules miss, else go to row 5.",
      };
    if (!input.T)
      return {
        row: 4,
        ship: false,
        action: "Do not ship A. Measure T plus method (row 5 onward).",
        needs: "T+method",
      };
  } else if (!input.T) {
    return {
      row: null,
      ship: false,
      needs: "T+method",
      action:
        "Row 0: whole bundle exceeds the budget, so A is skipped. Measure T plus method.",
    };
  }
  const t = (input.T as { recallAt10: number }).recallAt10;
  if (t >= th.T.recallAt10)
    return {
      row: 5,
      ship: true,
      action: "Ship T plus method; agents read up to 10 bodies.",
    };
  if (t >= th.T.patchFloorAt10)
    return {
      row: 6,
      ship: false,
      action:
        "Ship T and run the patch pass. Keep T if the held-out half reaches the bar, else go to row 7.",
    };
  if (!input.BM25)
    return {
      row: 7,
      ship: false,
      action: "Evaluate BM25 top-50 then select (row 7); below the bar, row 8.",
      needs: "BM25",
    };
  if (input.BM25.recallAt10 >= th.T.recallAt10)
    return { row: 7, ship: true, action: "Ship BM25 top-50 then select." };
  // Row 8: ship the best-measured mechanism (recall@10) as a stopgap; A is
  // excluded past the bundle budget. Open the embeddings spike (approach C).
  const candidates: ["A" | "T+method" | "BM25", number][] = [
    ["T+method", t],
    ["BM25", input.BM25.recallAt10],
  ];
  if (!overBudget && input.A?.recallAt10 !== undefined)
    candidates.push(["A", input.A.recallAt10]);
  const [stopgap, best] = candidates.reduce((x, y) => (y[1] > x[1] ? y : x));
  return {
    row: 8,
    ship: false,
    stopgap,
    action: `Ship ${stopgap} (recall@10 ${best.toFixed(3)}) as a stopgap and open an embeddings spike (approach C) with this gold set as its acceptance test.`,
  };
}
