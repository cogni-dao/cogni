// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/guards`
 * Purpose: Deterministic guards between the model's judgments and anything the prioritizer files (design v4).
 * Scope: Pure functions over parsed model output + the run context; does not call tools/LLMs or read env.
 * Invariants:
 *   - CONTEXT_BEFORE_JUDGMENT: a run with no knowledge AND no EDO context is rejected outright.
 *   - JUDGMENT_COVERAGE: judgments are keyed to snapshot items; a batch missing any item is incomplete
 *     (the cycle aborts — no partial ranking).
 *   - HYPOTHESES_DECIDABLE: a new hypothesis needs a predicate on a snapshot item, an observation source,
 *     and ≥1 hub citation (evidence_for edges must target knowledge rows); a missing/invalid deadline is
 *     normalized to now+14d (warning); the daily cap is enforced.
 * Side-effects: none
 * Links: schema.ts, rank.ts, plan.ts, .context/prioritizer-design-v4.md
 * @public
 */

import type { FetchedEntry, GatheredContext } from "./context";
import type { HypothesisProposal, ItemJudgment } from "./schema";
import { PRIORITIZER_EDO_DOMAIN } from "./tools";

/** Furthest a hypothesis deadline may be scheduled. */
export const MAX_EVALUATE_AT_DAYS = 365;
/** Deterministic deadline for a hypothesis whose own is missing or invalid. */
export const DEFAULT_EVALUATE_AT_DAYS = 14;

export type GuardReason =
  | "empty_context"
  | "judgment_unknown_item"
  | "judgment_duplicate"
  | "judgment_missing"
  | "hypothesis_unknown_item"
  | "hypothesis_ungrounded"
  | "hypothesis_evaluate_at_normalized"
  | "hypothesis_daily_cap";

export interface GuardViolation {
  readonly scope: "run" | "judgment" | "hypothesis";
  readonly ref: string;
  readonly reason: GuardReason;
  readonly detail?: string;
}

/** CONTEXT_BEFORE_JUDGMENT. */
export function guardRunContext(
  contextConsumed: GatheredContext["contextConsumed"]
): GuardViolation | null {
  if (
    contextConsumed.knowledgeIds.length === 0 &&
    contextConsumed.edoIds.length === 0
  ) {
    return {
      scope: "run",
      ref: "run",
      reason: "empty_context",
      detail: "no knowledge or EDO entries were read this run",
    };
  }
  return null;
}

/** JUDGMENT_COVERAGE: keep the first judgment per batch item; report unknown, duplicate, missing. */
export function guardJudgments(
  judgments: readonly ItemJudgment[],
  batchItemIds: readonly string[]
): {
  byId: Map<string, ItemJudgment>;
  missing: string[];
  violations: GuardViolation[];
} {
  const wanted = new Set(batchItemIds);
  const byId = new Map<string, ItemJudgment>();
  const violations: GuardViolation[] = [];
  for (const j of judgments) {
    if (!wanted.has(j.itemId)) {
      violations.push({
        scope: "judgment",
        ref: j.itemId,
        reason: "judgment_unknown_item",
      });
    } else if (byId.has(j.itemId)) {
      violations.push({
        scope: "judgment",
        ref: j.itemId,
        reason: "judgment_duplicate",
      });
    } else {
      byId.set(j.itemId, j);
    }
  }
  const missing = batchItemIds.filter((id) => !byId.has(id));
  for (const id of missing) {
    violations.push({ scope: "judgment", ref: id, reason: "judgment_missing" });
  }
  return { byId, missing, violations };
}

/** HYPOTHESES_DECIDABLE + daily cap. Returns proposals ready to file (deadline normalized). */
export function guardHypothesisProposals(
  proposals: readonly HypothesisProposal[],
  ctx: {
    readonly itemIds: ReadonlySet<string>;
    readonly hubIds: ReadonlySet<string>;
    readonly now: Date;
    readonly remainingToday: number;
  }
): { accepted: HypothesisProposal[]; violations: GuardViolation[] } {
  const accepted: HypothesisProposal[] = [];
  const violations: GuardViolation[] = [];
  const day = 24 * 60 * 60 * 1000;
  const maxMs = ctx.now.getTime() + MAX_EVALUATE_AT_DAYS * day;

  for (const p of proposals) {
    const ref = p.title.slice(0, 80);
    if (!ctx.itemIds.has(p.predicate.itemId)) {
      violations.push({
        scope: "hypothesis",
        ref,
        reason: "hypothesis_unknown_item",
        detail: p.predicate.itemId,
      });
      continue;
    }
    const citations = [
      ...new Set(p.citations.filter((c) => ctx.hubIds.has(c))),
    ];
    if (citations.length === 0) {
      violations.push({
        scope: "hypothesis",
        ref,
        reason: "hypothesis_ungrounded",
      });
      continue;
    }
    if (accepted.length >= ctx.remainingToday) {
      violations.push({
        scope: "hypothesis",
        ref,
        reason: "hypothesis_daily_cap",
      });
      continue;
    }
    let by = Date.parse(p.predicate.by);
    if (Number.isNaN(by) || by <= ctx.now.getTime() || by > maxMs) {
      violations.push({
        scope: "hypothesis",
        ref,
        reason: "hypothesis_evaluate_at_normalized",
        detail: p.predicate.by || "(missing)",
      });
      by = ctx.now.getTime() + DEFAULT_EVALUATE_AT_DAYS * day;
    }
    accepted.push({
      ...p,
      // The observation source is the predicate's own item — derived, not trusted.
      observationSource: `work_item:${p.predicate.itemId}`,
      predicate: { ...p.predicate, by: new Date(by).toISOString() },
      citations,
    });
  }
  return { accepted, violations };
}

/**
 * EDO_DOMAIN_FOLLOWS_CONTEXT: file EDO rows where the node keeps its goals — the domain of the
 * first approved objective fetched this cycle, else the first knowledge entry's, else "strategy".
 */
export function selectEdoDomain(
  objectives: readonly string[],
  entries: readonly FetchedEntry[]
): string {
  const usable = (d: string | undefined): d is string =>
    d !== undefined && d.length > 0 && d !== "unknown";
  for (const id of objectives) {
    const domain = entries.find((e) => e.id === id)?.domain;
    if (usable(domain)) return domain;
  }
  const first = entries.find(
    (e) => e.plane === "knowledge" && usable(e.domain)
  );
  return first?.domain ?? PRIORITIZER_EDO_DOMAIN;
}
