// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/work-prioritizer/rank`
 * Purpose: "lexicographic heuristic v1" — pure, deterministic priority assignment from judgments (design v4 §1–§2.3).
 * Scope: Eligibility gates, ordering, ceilings, hysteresis, pins, and rank numbers; does not call tools or LLMs.
 * Invariants:
 *   - GATES_FIRST: fixture/duplicate/superseded/no-objective-fit ⇒ p4 (a duplicate group keeps its canonical,
 *     lowest-id member ranked normally); blocked or needs_triage ⇒ never p0/p1, except a needs_triage live
 *     incident (expedite + evidenced ≤7-day harm); instruction-like item text (suspected injection) ⇒ never p0/p1;
 *     p0 needs a 7-day harm with evidence; p0/p1 need an approved objective and an evidenced why-now.
 *   - ORDER: service class → max approved-objective impact → effort (S<M<L) → item id (exact final tiebreak).
 *   - CEILINGS_NOT_TARGETS: p0/p1/p2 are filled only with eligible items up to their ceilings; p1 is
 *     independent of how many p0 exist; an empty p0 is healthy.
 *   - HYSTERESIS: a challenger displaces an incumbent p0/p1 only if strictly higher on service class or impact;
 *     incumbents come from the prior decision's table when there is one.
 *   - TRACKERS_BELOW_CHILDREN: an item with an actionable child in the snapshot is never p0/p1 (the child takes it).
 *   - PINS: `priority:pinned` items never move, count against their level's ceiling; overflow is reported and
 *     admits no new items to that level.
 *   - EXACTLY_ONE_ROW: every snapshot item gets exactly one row with a unique rank 1..N.
 * Side-effects: none
 * Links: .context/prioritizer-design-v4.md, schema.ts (RankedRow)
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
  /** Current priority (null = unset). */
  readonly priority: number | null;
  readonly labels: readonly string[];
  readonly blockedBy?: string;
  readonly summary?: string;
  readonly outcome?: string;
  readonly parentId?: string;
  /** Current rank (null = unset). */
  readonly rank?: number | null;
  /**
   * INCUMBENT_FROM_PRIOR_DECISION: the level the prior decision assigned (propose mode never
   * writes, so item fields are stale). Undefined → the item's current priority is the incumbent.
   */
  readonly incumbent?: number | null;
}

export interface RankPolicy {
  readonly p0Max: number;
  readonly p1Budget: number;
  readonly p2Budget: number;
  readonly objectives: readonly string[];
}

export interface RankInput {
  readonly items: readonly RankItem[];
  readonly judgments: ReadonlyMap<string, ItemJudgment>;
  readonly policy: RankPolicy;
  /** Ids fetched this cycle (work items + hub entries) — the only admissible evidence. */
  readonly knownEvidenceIds: ReadonlySet<string>;
  readonly duplicateGroups: readonly (readonly string[])[];
  readonly blockerCycleMembers: ReadonlySet<string>;
}

export interface Overflow {
  readonly level: number;
  readonly pinned: number;
  readonly ceiling: number;
}

export interface RankResult {
  readonly rows: RankedRow[];
  readonly overflow: Overflow[];
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
  readonly objective: string | null;
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

/** Hysteresis test: strictly higher on service class OR on objective impact. */
function strictlyHigher(challenger: Scored, incumbent: Scored): boolean {
  return (
    challenger.serviceRank < incumbent.serviceRank ||
    challenger.maxImpact > incumbent.maxImpact
  );
}

function score(input: RankInput, item: RankItem): Scored {
  const j = input.judgments.get(item.id);
  const reasons: string[] = [];
  let maxImpact = 0;
  let objective: string | null = null;
  for (const obj of input.policy.objectives) {
    const v = j?.impact[obj] ?? 0;
    if (v > maxImpact) {
      maxImpact = v;
      objective = obj;
    }
  }
  const pinned = item.labels.includes(PINNED_LABEL);
  const known = (id: string | undefined) =>
    id !== undefined && input.knownEvidenceIds.has(id);

  const s: Scored = {
    item,
    judgment: j,
    maxImpact,
    objective,
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
  if (j && maxImpact === 0) reasons.push("no_objective_fit_p4");
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

/**
 * Fill one level from `pool` up to `capacity`, with hysteresis protecting incumbents
 * (items currently at `level`). Returns the chosen ids in order.
 */
function fillLevel(
  pool: Scored[],
  capacity: number,
  level: number,
  useHysteresis: boolean
): Scored[] {
  const sorted = [...pool].sort(compareScored);
  const selected = sorted.slice(0, Math.max(0, capacity));
  if (!useHysteresis || capacity <= 0) return selected;

  const incumbentLevel = (s: Scored) =>
    s.item.incumbent !== undefined ? s.item.incumbent : s.item.priority;
  const incumbents = sorted.filter(
    (s) => incumbentLevel(s) === level && !selected.includes(s)
  );
  for (const inc of incumbents) {
    const challengers = selected
      .filter((s) => incumbentLevel(s) !== level)
      .sort(compareScored);
    const weakest = challengers[challengers.length - 1];
    if (weakest && !strictlyHigher(weakest, inc)) {
      selected[selected.indexOf(weakest)] = inc;
      inc.reasons.push(`hysteresis_kept_p${level}`);
    }
  }
  return selected.sort(compareScored);
}

/** Run the heuristic. Pure: same input → same output. */
export function rankItems(input: RankInput): RankResult {
  const scored = input.items.map((item) => score(input, item));
  const levelOf = new Map<Scored, number>();
  const overflow: Overflow[] = [];

  // PINS — never move; count against ceilings.
  const pinnedAt = [0, 0, 0, 0, 0];
  for (const s of scored) {
    if (!s.pinned) continue;
    const lvl = Math.min(4, Math.max(0, s.item.priority ?? 3));
    levelOf.set(s, lvl);
    pinnedAt[lvl] = (pinnedAt[lvl] ?? 0) + 1;
  }
  const ceilings = [
    input.policy.p0Max,
    input.policy.p1Budget,
    input.policy.p2Budget,
  ];
  const capacity = ceilings.map((c, lvl) => {
    const pinned = pinnedAt[lvl] ?? 0;
    if (pinned > c) overflow.push({ level: lvl, pinned, ceiling: c });
    return Math.max(0, c - pinned);
  });

  for (const s of scored) if (!s.pinned && s.p4) levelOf.set(s, 4);
  const open = () => scored.filter((s) => !levelOf.has(s));

  const p0 = fillLevel(
    open().filter((s) => s.p0Eligible),
    capacity[0] ?? 0,
    0,
    true
  );
  for (const s of p0) levelOf.set(s, 0);
  const p1 = fillLevel(
    open().filter((s) => s.p1Eligible),
    capacity[1] ?? 0,
    1,
    true
  );
  for (const s of p1) levelOf.set(s, 1);
  const p2 = fillLevel(
    open().filter((s) => s.p2Eligible),
    capacity[2] ?? 0,
    2,
    false
  );
  for (const s of p2) levelOf.set(s, 2);
  for (const s of open()) {
    if (s.p0Eligible || s.p1Eligible || s.p2Eligible)
      s.reasons.push("ceiling_full");
    levelOf.set(s, 3);
  }

  const ordered = [...scored].sort(
    (a, b) =>
      (levelOf.get(a) ?? 3) - (levelOf.get(b) ?? 3) || compareScored(a, b)
  );
  const rows: RankedRow[] = ordered.map((s, i) => ({
    itemId: s.item.id,
    revision: s.item.revision,
    from: s.item.priority,
    fromRank: s.item.rank ?? null,
    to: levelOf.get(s) ?? 3,
    rank: i + 1,
    pinned: s.pinned,
    serviceClass: s.judgment?.serviceClass ?? null,
    maxImpact: s.maxImpact,
    objective: s.objective,
    effort: s.judgment?.effort ?? null,
    whyNow: s.judgment?.whyNow ?? null,
    harmIfWait: s.judgment?.harmIfWait ?? null,
    reasons: s.reasons,
  }));
  return { rows, overflow };
}
