// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/plan`
 * Purpose: Pure planning helpers (design v4 §2.4–§2.7): plan rows, diff vs the prior decision, the no-change
 *   rule, the prior decision memo, and review scope (daily full review vs delta).
 * Scope: Pure functions over ranked rows and parsed hub content; does not call tools, LLMs, or read env.
 * Invariants:
 *   - PLAN_IS_CHANGED_ROWS: a row is planned iff its priority OR rank changes (never pinned or unjudged rows).
 *   - NO_CHANGE_NO_DECISION: nothing to propose, or the same table as the prior decision ⇒ no decision.
 *   - DAILY_FULL_REVIEW / DELTA_SCOPE (selectJudgeSet): see below.
 * Side-effects: none
 * Links: .context/prioritizer-design-v4.md, schema.ts
 * @public
 */

import {
  type DecisionPayload,
  type ItemJudgment,
  MemoJudgmentSchema,
  type PlanRow,
  type RankedRow,
} from "./schema";

/** PLAN_IS_CHANGED_ROWS — a model failure (unjudged) never moves an item; p0 rows still need rank 1..k. */
export function buildPlan(rows: readonly RankedRow[]): PlanRow[] {
  return rows
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
    }));
}

/** Rows whose proposed priority differs from the prior decision's (all rows when there is no prior table). */
export function diffVsPrior(
  rows: readonly RankedRow[],
  priorTable: ReadonlyMap<string, number> | null
): DecisionPayload["diffVsPrior"] {
  return rows
    .filter((r) => priorTable?.get(r.itemId) !== r.to)
    .map((r) => ({
      itemId: r.itemId,
      priorTo: priorTable?.get(r.itemId) ?? null,
      to: r.to,
    }));
}

/** NO_CHANGE_NO_DECISION. */
export const isNoChange = (
  plan: readonly PlanRow[],
  diff: readonly unknown[],
  hasPriorTable: boolean
) => plan.length === 0 || (hasPriorTable && diff.length === 0);

export const DECISION_ID_RE = /^work-prioritizer-\d{8}t\d{4}-decision$/;
export type ReviewScope = "full" | "delta";

/** The newest prior prioritizer decision: what this cycle may reuse (empty fields for v0 decisions). */
export interface PriorDecision {
  readonly id: string;
  readonly promptVersion: string | null;
  readonly goals: readonly string[];
  /** Last full review (null for decisions filed before DAILY_FULL_REVIEW existed). */
  readonly reviewedAt: string | null;
  readonly consumedIds: ReadonlySet<string>;
  readonly judgments: ReadonlyMap<
    string,
    { readonly revision: number | null; readonly judgment: ItemJudgment }
  >;
  /** `itemId → to`, or null when the decision carries no table. */
  readonly table: ReadonlyMap<string, number> | null;
}

/** The newest prioritizer decision among `entries` (ids sort by cycle stamp), parsed; or null. */
export function newestPriorDecision(
  entries: readonly { readonly id: string; readonly content: string }[]
): PriorDecision | null {
  const e = entries
    .filter((x) => DECISION_ID_RE.test(x.id))
    .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  if (!e) return null;
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(
      [...e.content.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1] ?? "{}"
    );
  } catch {
    // unreadable payload → nothing to reuse
  }
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const cc = (raw.contextConsumed ?? {}) as Record<string, unknown>;
  const judgments = list(raw.judgments).flatMap((j) => {
    const p = MemoJudgmentSchema.safeParse(j);
    return p.success ? [[p.data.itemId, p.data] as const] : [];
  });
  const rows = list(raw.table) as { itemId?: unknown; to?: unknown }[];
  return {
    id: e.id,
    promptVersion:
      typeof raw.promptVersion === "string" ? raw.promptVersion : null,
    goals: strings(raw.goals),
    reviewedAt: typeof raw.reviewedAt === "string" ? raw.reviewedAt : null,
    consumedIds: new Set(
      ["workItemIds", "knowledgeIds", "edoIds"].flatMap((k) => strings(cc[k]))
    ),
    judgments: new Map(judgments),
    table: Array.isArray(raw.table)
      ? new Map(
          rows.flatMap((r) =>
            typeof r.itemId === "string" && typeof r.to === "number"
              ? [[r.itemId, r.to] as const]
              : []
          )
        )
      : null,
  };
}

/**
 * DAILY_FULL_REVIEW + DELTA_SCOPE + MEMOIZED_JUDGMENTS — which items this cycle sends to the model.
 *
 * Full review (every item re-judged): requested, no prior memo or one without `reviewedAt`, a changed
 * prompt or active goal set (every memoized judgment is stale), or the first cycle of a new UTC day.
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
    readonly goals: readonly string[];
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
  const memo = prior;
  const full =
    ctx.requested ||
    !memo?.reviewedAt ||
    memo.promptVersion !== ctx.promptVersion ||
    memo.goals.length !== ctx.goals.length ||
    !memo.goals.every((g) => ctx.goals.includes(g)) ||
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
      (memo.table?.get(i.id) ?? 4) <= 1;
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
