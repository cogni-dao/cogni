// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/rank`
 * Purpose: "lexicographic heuristic v2" — pure, deterministic priority assignment from judgments (dao-goals-design).
 * Scope: Eligibility gates, ordering, pins, and rank numbers; does not call tools or LLMs.
 * Invariants:
 *   - GATES_FIRST: fixture/duplicate/superseded/no-goal-fit ⇒ p4 (a duplicate group keeps its canonical,
 *     lowest-id member ranked normally); blocked or needs_triage ⇒ never p0/p1, except a needs_triage live
 *     incident (expedite + evidenced ≤7-day harm); instruction-like item text (suspected injection) ⇒ never p0/p1.
 *   - P0P1_CITES_GOAL: p0/p1 need an active goal (impact ≥ 1 on a listed `goal-*` id, carried as `goal`) and an
 *     evidenced why-now; p0 also needs an evidenced harm within 7 days.
 *   - NO_CAPS: every eligible item takes its level — no ceilings (privileged p0/p1 removes inflation at its source).
 *   - ORDER: service class → max goal impact → effort (S<M<L) → item id (exact final tiebreak).
 *   - TRACKERS_BELOW_CHILDREN: an item with an actionable child in the snapshot is never p0/p1 (the child takes it).
 *   - PINS: `priority:pinned` items never move.
 *   - EXACTLY_ONE_ROW: every snapshot item gets exactly one row with a unique rank 1..N.
 * Side-effects: none
 * Links: dao-goals-design, schema.ts (RankedRow)
 * @public
 */

import type { Effort, ItemJudgment, RankedRow, ServiceClass } from "./schema";

export const PINNED_LABEL = "priority:pinned";
export const P0_HARM_WINDOW_DAYS = 7;

const SERVICE_ORDER: Record<ServiceClass, number> = {
  expedite: 0,
  fixed_date: 1,
  standard: 2,
  intangible: 3,
};
const EFFORT_ORDER: Record<Effort, number> = { S: 0, M: 1, L: 2 };

export interface RankItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number | null;
  /** Current priority (null/absent = unset). */
  readonly priority?: number | null;
  readonly labels: readonly string[];
  readonly blockedBy?: string;
  readonly summary?: string;
  readonly outcome?: string;
  readonly parentId?: string;
  /** Current rank (null = unset). */
  readonly rank?: number | null;
}

export interface RankInput {
  readonly items: readonly RankItem[];
  readonly judgments: ReadonlyMap<string, ItemJudgment>;
  /** Active goal ids (`goal-*`) — the only things impact may cite. */
  readonly goals: readonly string[];
  /** Ids fetched this cycle (work items + hub entries) — the only admissible evidence. */
  readonly knownEvidenceIds: ReadonlySet<string>;
  readonly duplicateGroups: readonly (readonly string[])[];
  readonly blockerCycleMembers: ReadonlySet<string>;
}

const FIXTURE_RE =
  /\b(fixture|fixtures|validation probe|e2e proof|proof work item)\b/i;

export function isFixture(item: RankItem): boolean {
  return (
    item.labels.some((l) => l.toLowerCase() === "fixture") ||
    FIXTURE_RE.test(item.title) ||
    FIXTURE_RE.test(item.summary ?? "")
  );
}

/** Instruction-like text aimed at an agent — a prompt-injection signal, never a reason to promote. */
const INJECTION_RE =
  /ignore (all )?(previous|prior|above) instructions|disregard (all )?(previous|prior) instructions|you are now (authorized|an?)|system prompt|\bcore__[a-z_]+/i;

export function looksLikeInjection(item: RankItem): boolean {
  return [item.title, item.summary ?? "", item.outcome ?? ""].some((t) =>
    INJECTION_RE.test(t)
  );
}

export function isBlocked(
  item: RankItem,
  cycleMembers: ReadonlySet<string>
): boolean {
  return (
    item.status === "blocked" ||
    item.blockedBy !== undefined ||
    cycleMembers.has(item.id) ||
    /\bBLOCKED\b/.test(item.outcome ?? "")
  );
}

/** The canonical member of a duplicate group: the lowest id (the oldest item). */
export function canonicalOfGroup(group: readonly string[]): string {
  return [...group].sort()[0] as string;
}

function isNonCanonicalDuplicate(
  id: string,
  groups: readonly (readonly string[])[]
): boolean {
  const g = groups.find((x) => x.includes(id));
  return g !== undefined && canonicalOfGroup(g) !== id;
}

interface Scored {
  readonly item: RankItem;
  readonly judgment: ItemJudgment | undefined;
  readonly maxImpact: number;
  readonly goal: string | null;
  readonly serviceRank: number;
  readonly effortRank: number;
  readonly pinned: boolean;
  readonly reasons: string[];
  p4: boolean;
  p0Eligible: boolean;
  p1Eligible: boolean;
  p2Eligible: boolean;
}

/** service class → max impact (desc) → effort → id. */
export function compareScored(
  a: Pick<Scored, "serviceRank" | "maxImpact" | "effortRank" | "item">,
  b: Pick<Scored, "serviceRank" | "maxImpact" | "effortRank" | "item">
): number {
  return (
    a.serviceRank - b.serviceRank ||
    b.maxImpact - a.maxImpact ||
    a.effortRank - b.effortRank ||
    (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0)
  );
}

function score(input: RankInput, item: RankItem): Scored {
  const j = input.judgments.get(item.id);
  const reasons: string[] = [];
  let maxImpact = 0;
  let goal: string | null = null;
  for (const g of input.goals) {
    const v = j?.impact[g] ?? 0;
    if (v > maxImpact) {
      maxImpact = v;
      goal = g;
    }
  }
  const pinned = item.labels.includes(PINNED_LABEL);
  const known = (id: string | undefined) =>
    id !== undefined && input.knownEvidenceIds.has(id);

  const s: Scored = {
    item,
    judgment: j,
    maxImpact,
    goal,
    serviceRank: j ? SERVICE_ORDER[j.serviceClass] : 9,
    effortRank: j ? EFFORT_ORDER[j.effort] : 9,
    pinned,
    reasons,
    p4: false,
    p0Eligible: false,
    p1Eligible: false,
    p2Eligible: false,
  };
  if (pinned) {
    reasons.push("pinned");
    return s;
  }

  // GATES_FIRST — p4
  const group = input.duplicateGroups.find((g) => g.includes(item.id));
  const canonical = group ? canonicalOfGroup(group) : undefined;
  const isDuplicate = canonical !== undefined && canonical !== item.id;
  // DUPLICATES_KEEP_CANONICAL: supersession never points inside the item's own duplicate group, nor
  // at an item that is itself gated to p4 (a fixture or a non-canonical duplicate) — otherwise the
  // model could demote the canonical member too (live: bug.5001 "superseded by" its duplicate bug.5006).
  const target = j?.supersededBy ?? null;
  const targetItem = target
    ? input.items.find((i) => i.id === target)
    : undefined;
  const superseded =
    targetItem !== undefined &&
    target !== item.id &&
    !(group?.includes(target as string) ?? false) &&
    !isFixture(targetItem) &&
    !isNonCanonicalDuplicate(target as string, input.duplicateGroups);
  if (isFixture(item)) reasons.push("fixture_p4");
  if (isDuplicate) reasons.push("duplicate_p4", `duplicate_of:${canonical}`);
  if (superseded) reasons.push("superseded_p4");
  if (j && maxImpact === 0) reasons.push("no_goal_fit_p4");
  if (reasons.length > 0) {
    s.p4 = true;
    return s;
  }
  if (!j) {
    reasons.push("unjudged_p3");
    return s;
  }

  const blocked = isBlocked(item, input.blockerCycleMembers);
  const tracker = input.items.some((i) => i.parentId === item.id);
  const whyNowOk = known(j.whyNow.evidenceId);
  const harm7d =
    known(j.harmIfWait.evidenceId) &&
    j.harmIfWait.withinDays !== null &&
    j.harmIfWait.withinDays <= P0_HARM_WINDOW_DAYS;
  // INCIDENT_EXCEPTION: a needs_triage item that is a live incident (expedite + evidenced ≤7-day
  // harm) may enter p0/p1; every other needs_triage item stays out.
  const incident = j.serviceClass === "expedite" && harm7d && whyNowOk;
  const triage = item.status === "needs_triage" && !incident;
  const injection = looksLikeInjection(item);
  if (injection) reasons.push("suspected_injection_not_p0p1");
  if (blocked) reasons.push("blocked_not_p0p1");
  if (triage) reasons.push("triage_not_p0p1");
  if (item.status === "needs_triage" && incident)
    reasons.push("triage_incident_exception");
  if (tracker) reasons.push("tracker_not_above_child");
  if (!whyNowOk) reasons.push("why_now_unevidenced");

  s.p2Eligible = maxImpact >= 1;
  s.p1Eligible =
    s.p2Eligible && !blocked && !triage && !tracker && !injection && whyNowOk;
  s.p0Eligible = s.p1Eligible && harm7d;
  if (s.p1Eligible && !harm7d) reasons.push("no_7d_harm_not_p0");
  return s;
}

/** Run the heuristic. Pure: same input → same output. NO_CAPS: every eligible item takes its level. */
export function rankItems(input: RankInput): RankedRow[] {
  const scored = input.items.map((item) => score(input, item));
  const levelOf = (s: Scored) =>
    s.pinned
      ? Math.min(4, Math.max(0, s.item.priority ?? 3))
      : s.p4
        ? 4
        : s.p0Eligible
          ? 0
          : s.p1Eligible
            ? 1
            : s.p2Eligible
              ? 2
              : 3;
  return [...scored]
    .sort((a, b) => levelOf(a) - levelOf(b) || compareScored(a, b))
    .map((s, i) => ({
      itemId: s.item.id,
      revision: s.item.revision,
      from: s.item.priority ?? null,
      fromRank: s.item.rank ?? null,
      to: levelOf(s),
      rank: i + 1,
      pinned: s.pinned,
      serviceClass: s.judgment?.serviceClass ?? null,
      maxImpact: s.maxImpact,
      goal: s.goal,
      effort: s.judgment?.effort ?? null,
      whyNow: s.judgment?.whyNow ?? null,
      harmIfWait: s.judgment?.harmIfWait ?? null,
      reasons: s.reasons,
    }));
}
