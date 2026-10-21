// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/plan`
 * Purpose: Pure planning + EDO-evidence helpers (design v4 §2.4–§2.7): plan rows, diff vs the prior decision,
 *   the no-change rule, review scope (daily full review vs delta), memoized judgments, predicate evaluation
 *   for due hypotheses, and the daily hypothesis cap.
 * Scope: Pure functions over ranked rows and parsed hub content; does not call tools, LLMs, or read env.
 * Invariants:
 *   - PLAN_IS_CHANGED_ROWS: a plan row exists iff the proposed priority OR rank differs from the current
 *     one (pinned and unjudged rows are never planned).
 *   - NO_CHANGE_NO_DECISION: nothing to propose, or the same table as the prior decision ⇒ file no decision.
 *   - DAILY_FULL_REVIEW / DELTA_SCOPE (selectJudgeSet): a full review re-judges everything at most daily unless
 *     requested; a delta cycle re-considers only p0/p1, unprioritized, and changed items; the rest carry.
 *   - PREDICATES_ARE_DECIDABLE: a due hypothesis resolves only from observed work-item state; otherwise it stays
 *     open as insufficient_evidence.
 * Side-effects: none
 * Links: .context/prioritizer-design-v4.md, schema.ts
 * @public
 */

import {
  type DecisionPayload,
  type HypothesisPredicate,
  HypothesisPredicateSchema,
  type ItemJudgment,
  MemoJudgmentSchema,
  type PlanRow,
  type RankedRow,
} from "./schema";

/** PLAN_IS_CHANGED_ROWS. */
export function buildPlan(rows: readonly RankedRow[]): PlanRow[] {
  return (
    rows
      // Unjudged rows are never written: a model failure must not move an item.
      // EVERY_PLACED_ITEM_GETS_ITS_RANK: a row is planned when its priority OR its rank changes
      // (the top tier keeps p0 but still needs rank 1..k).
      .filter(
        (r) =>
          !r.pinned &&
          !r.reasons.includes("unjudged_p3") &&
          (r.from !== r.to || (r.fromRank ?? null) !== r.rank)
      )
      .map((r) => ({
        itemId: r.itemId,
        from: r.from,
        to: r.to,
        rank: r.rank,
        expectedRevision: r.revision,
      }))
  );
}

/** Rows whose proposed priority differs from the prior decision's (all rows when there is no prior table). */
export function diffVsPrior(
  rows: readonly RankedRow[],
  priorTable: ReadonlyMap<string, number> | null
): DecisionPayload["diffVsPrior"] {
  return rows
    .filter((r) => !priorTable || priorTable.get(r.itemId) !== r.to)
    .map((r) => ({
      itemId: r.itemId,
      priorTo: priorTable?.get(r.itemId) ?? null,
      to: r.to,
    }));
}

/** NO_CHANGE_NO_DECISION. */
export function isNoChange(
  plan: readonly PlanRow[],
  diff: DecisionPayload["diffVsPrior"],
  hasPriorTable: boolean
): boolean {
  return plan.length === 0 || (hasPriorTable && diff.length === 0);
}

function lastJsonBlock(content: string): unknown {
  const blocks = [...content.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = blocks[blocks.length - 1]?.[1];
  if (!last) return undefined;
  try {
    return JSON.parse(last);
  } catch {
    return undefined;
  }
}

/** The prior decision's `itemId → to` table, or null when it carries none (e.g. a v0 decision). */
export function parsePriorTable(content: string): Map<string, number> | null {
  const raw = lastJsonBlock(content) as { table?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.table)) return null;
  const out = new Map<string, number>();
  for (const row of raw.table as { itemId?: unknown; to?: unknown }[]) {
    if (typeof row.itemId === "string" && typeof row.to === "number") {
      out.set(row.itemId, row.to);
    }
  }
  return out;
}

/** The decidable predicate embedded in a prioritizer hypothesis, if any. */
export function parseHypothesisPredicate(
  content: string
): { observationSource: string; predicate: HypothesisPredicate } | null {
  const raw = lastJsonBlock(content) as
    | { observationSource?: unknown; predicate?: unknown }
    | undefined;
  if (!raw || typeof raw.observationSource !== "string") return null;
  const parsed = HypothesisPredicateSchema.safeParse(raw.predicate);
  return parsed.success
    ? { observationSource: raw.observationSource, predicate: parsed.data }
    : null;
}

export type PredicateResult =
  | "validates"
  | "invalidates"
  | "insufficient_evidence"
  | "not_due";

/**
 * PREDICATES_ARE_DECIDABLE. `observedStatus` undefined = the item was not observed.
 * Satisfied early ⇒ validates; past the deadline and unsatisfied ⇒ invalidates.
 */
export function evaluatePredicate(
  predicate: HypothesisPredicate,
  observedStatus: string | undefined,
  now: Date
): PredicateResult {
  const by = Date.parse(predicate.by);
  const due = Number.isNaN(by) || now.getTime() >= by;
  if (observedStatus === undefined) {
    return due ? "insufficient_evidence" : "not_due";
  }
  if (observedStatus === predicate.equals) return "validates";
  return due ? "invalidates" : "not_due";
}

/** Prioritizer hypotheses already filed on `now`'s UTC day (ids carry the cycle stamp). */
export function hypothesesFiledToday(
  hubIds: readonly string[],
  now: Date
): number {
  const day = now.toISOString().slice(0, 10).split("-").join("");
  const re = new RegExp(`^work-prioritizer-${day}t\\d{4}-h\\d+$`);
  return hubIds.filter((id) => re.test(id)).length;
}

/** What the prior decision lets this cycle reuse. */
export interface PriorDecisionMemo {
  readonly promptVersion: string | null;
  readonly objectives: readonly string[];
  /** Last full review (null for decisions filed before DAILY_FULL_REVIEW existed). */
  readonly reviewedAt: string | null;
  readonly consumedIds: ReadonlySet<string>;
  readonly judgments: ReadonlyMap<
    string,
    { readonly revision: number | null; readonly judgment: ItemJudgment }
  >;
}

/** Parse the memoizable parts of a prior decision (empty for v0 decisions). */
export function parsePriorMemo(content: string): PriorDecisionMemo {
  const raw = (lastJsonBlock(content) ?? {}) as {
    promptVersion?: unknown;
    objectives?: unknown;
    reviewedAt?: unknown;
    contextConsumed?: Record<string, unknown>;
    judgments?: unknown;
  };
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const judgments = new Map<
    string,
    { revision: number | null; judgment: ItemJudgment }
  >();
  for (const j of Array.isArray(raw.judgments) ? raw.judgments : []) {
    const parsed = MemoJudgmentSchema.safeParse(j);
    if (parsed.success) judgments.set(parsed.data.itemId, parsed.data);
  }
  const cc = raw.contextConsumed ?? {};
  return {
    promptVersion:
      typeof raw.promptVersion === "string" ? raw.promptVersion : null,
    objectives: strings(raw.objectives),
    reviewedAt: typeof raw.reviewedAt === "string" ? raw.reviewedAt : null,
    consumedIds: new Set(
      ["workItemIds", "knowledgeIds", "edoIds"].flatMap((k) => strings(cc[k]))
    ),
    judgments,
  };
}

export type ReviewScope = "full" | "delta";

/** The newest prior prioritizer decision, parsed for reuse. */
export interface PriorDecision {
  readonly id: string;
  readonly memo: PriorDecisionMemo;
  readonly table: ReadonlyMap<string, number> | null;
}

export const DECISION_ID_RE = /^work-prioritizer-\d{8}t\d{4}-decision$/;
const HYPOTHESIS_ID_RE = /^work-prioritizer-\d{8}t\d{4}-h\d+$/;

/** The newest prioritizer decision among `entries` (ids sort by cycle stamp), or null. */
export function newestPriorDecision(
  entries: readonly { readonly id: string; readonly content: string }[]
): PriorDecision | null {
  const e = entries
    .filter((x) => DECISION_ID_RE.test(x.id))
    .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  return e
    ? {
        id: e.id,
        memo: parsePriorMemo(e.content),
        table: parsePriorTable(e.content),
      }
    : null;
}

/** The prioritizer's own hypotheses among `entries` that carry a decidable predicate, oldest first. */
export function openHypotheses<
  T extends { readonly id: string; readonly content: string },
>(
  entries: readonly T[]
): {
  entry: T;
  observationSource: string;
  predicate: HypothesisPredicate;
}[] {
  return entries
    .filter((e) => HYPOTHESIS_ID_RE.test(e.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .flatMap((entry) => {
      const p = parseHypothesisPredicate(entry.content);
      return p ? [{ entry, ...p }] : [];
    });
}

/**
 * DAILY_FULL_REVIEW + DELTA_SCOPE + MEMOIZED_JUDGMENTS — which items this cycle sends to the model.
 *
 * Full review (every item re-judged): requested, no prior memo or one without `reviewedAt`, a changed
 * prompt or objective set (every memoized judgment is stale), or the first cycle of a new UTC day.
 * Delta cycle: the delta is every current p0/p1 (in the store or the prior table), every unprioritized
 * item, and every item whose revision differs from the one the prior decision judged (new items
 * included). A delta item is re-judged unless its revision is unchanged and no NEW hub evidence (not
 * consumed by the prior cycle, not the prioritizer's own rows) mentions it. Every item outside the delta
 * carries its prior judgment, so the ceilings still rank the whole backlog.
 */
export function selectJudgeSet<
  T extends {
    readonly id: string;
    readonly revision: number | null;
    readonly priority?: number;
  },
>(
  items: readonly T[],
  prior: PriorDecision | null,
  ctx: {
    readonly now: string;
    readonly promptVersion: string;
    readonly objectives: readonly string[];
    readonly requested: boolean;
    readonly hubEntries: readonly {
      readonly id: string;
      readonly content: string;
    }[];
  }
): {
  scope: ReviewScope;
  delta: string[];
  carried: Map<string, ItemJudgment>;
  toJudge: T[];
} {
  const memo = prior?.memo;
  const full =
    ctx.requested ||
    !memo?.reviewedAt ||
    memo.promptVersion !== ctx.promptVersion ||
    memo.objectives.length !== ctx.objectives.length ||
    !memo.objectives.every((o) => ctx.objectives.includes(o)) ||
    memo.reviewedAt.slice(0, 10) < ctx.now.slice(0, 10);
  if (full || !memo) {
    const delta = items.map((i) => i.id);
    return { scope: "full", delta, carried: new Map(), toJudge: [...items] };
  }
  const carried = new Map<string, ItemJudgment>();
  const delta: string[] = [];
  const toJudge: T[] = [];
  for (const i of items) {
    const m = memo.judgments.get(i.id);
    const unchanged = i.revision !== null && m?.revision === i.revision;
    const inDelta =
      !unchanged ||
      i.priority === undefined ||
      i.priority <= 1 ||
      (prior?.table?.get(i.id) ?? 4) <= 1;
    const newEvidence =
      inDelta &&
      ctx.hubEntries.some(
        (e) =>
          !memo.consumedIds.has(e.id) &&
          !e.id.startsWith("work-prioritizer-") &&
          e.content.includes(i.id)
      );
    if (inDelta) delta.push(i.id);
    if (m && unchanged && !newEvidence) carried.set(i.id, m.judgment);
    else toJudge.push(i);
  }
  return { scope: "delta", delta, carried, toJudge };
}
