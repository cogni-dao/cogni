// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/evals/work-prioritizer/score`
 * Purpose: Pure graders for the work-prioritizer eval (design v4 §4): each check returns pass/fail plus a reason.
 * Scope: Pure functions over decision payloads, snapshots, policy, and fixture; does not perform IO.
 * Invariants:
 *   - GRADERS_ARE_PURE: same input → same verdict; unit-tested in tests/evals/work-prioritizer.score.test.ts.
 *   - GATE = every hard + behavioral check passes; the soft PM-precision metric is reported only.
 *   - PROPOSE_GATE: the graph is propose-only, so the `write` section's graders (apply records, live
 *     priorities, observed scheduled applies) are SKIPPED and listed as such; they gate again once a
 *     write path exists.
 * Side-effects: none
 * Links: evals/work-prioritizer/README.md, run.ts, .context/prioritizer-design-v4.md
 * @public
 */

import type { DecisionPayload } from "../../src/graphs/work-prioritizer/schema";

export interface SnapshotItem {
  readonly id: string;
  readonly status: string;
  readonly revision?: number;
  readonly blockedBy?: string;
  readonly priority?: number | null;
}

export interface Fixture {
  readonly duplicateGroups: readonly { readonly items: readonly string[] }[];
  readonly injectionItems: readonly { readonly id: string }[];
  readonly fixtureItems: readonly { readonly id: string }[];
  readonly pmLabels: { readonly p0: readonly string[] };
}

export interface CheckResult {
  readonly pass: boolean;
  readonly reason: string;
}

export const ACTIONABLE_STATUSES = [
  "needs_triage",
  "needs_research",
  "needs_design",
  "needs_implement",
  "needs_closeout",
  "needs_merge",
  "blocked",
] as const;

const ok = (reason: string): CheckResult => ({ pass: true, reason });
const fail = (reason: string): CheckResult => ({ pass: false, reason });

export const p0Of = (payload: DecisionPayload): string[] =>
  payload.table
    .filter((r) => r.to === 0)
    .map((r) => r.itemId)
    .sort();

const actionableOf = (snapshot: readonly SnapshotItem[]) =>
  snapshot.filter((i) =>
    (ACTIONABLE_STATUSES as readonly string[]).includes(i.status)
  );

/** `ids` each have exactly one table row and a judgment (fresh or carried) or an explicit unjudged listing. */
function covered(payload: DecisionPayload, ids: readonly string[]): string[] {
  const rows = new Map<string, number>();
  for (const r of payload.table)
    rows.set(r.itemId, (rows.get(r.itemId) ?? 0) + 1);
  const accounted = new Set([
    ...payload.judgments.map((j) => j.itemId),
    ...payload.unjudged,
  ]);
  return [
    ...ids.filter((id) => !rows.has(id)).map((id) => `${id}: no row`),
    ...[...rows]
      .filter(([, n]) => n > 1)
      .map(([id]) => `${id}: duplicate rows`),
    ...ids
      .filter((id) => rows.has(id) && !accounted.has(id))
      .map((id) => `${id}: not judged`),
  ];
}

/** Full review: every actionable item has exactly one row and is judged (or listed unjudged). */
export function gradeCoverage(
  payload: DecisionPayload,
  snapshot: readonly SnapshotItem[]
): CheckResult {
  if (payload.scope !== "full")
    return fail(`scope ${payload.scope} (want full)`);
  const ids = actionableOf(snapshot).map((i) => i.id);
  const bad = covered(payload, ids);
  return bad.length
    ? fail(bad.slice(0, 5).join("; "))
    : ok(
        `full review: ${ids.length}/${ids.length} actionable items judged and ranked`
      );
}

/**
 * The delta a cycle must re-consider (DELTA_SCOPE), recomputed independently: actionable items that are
 * p0/p1 or unprioritized in the store, p0/p1 in the prior decision's table, or whose revision differs
 * from the one the prior decision judged (new items included).
 */
export function expectedDelta(
  snapshot: readonly SnapshotItem[],
  prior: DecisionPayload
): string[] {
  const level = new Map(prior.table.map((r) => [r.itemId, r.to]));
  const judged = new Map(prior.judgments.map((j) => [j.itemId, j.revision]));
  return actionableOf(snapshot)
    .filter(
      (i) =>
        i.priority == null ||
        i.priority <= 1 ||
        (level.get(i.id) ?? 4) <= 1 ||
        i.revision === undefined ||
        judged.get(i.id) !== i.revision
    )
    .map((i) => i.id);
}

/** Delta cycle: 100% of the expected delta re-considered, judged, and ranked; the table still covers the backlog. */
export function gradeDeltaCoverage(
  payload: DecisionPayload,
  prior: DecisionPayload | null,
  snapshot: readonly SnapshotItem[]
): CheckResult {
  if (payload.scope !== "delta")
    return fail(`scope ${payload.scope} (want delta)`);
  if (!prior) return fail("prior decision not readable");
  const expected = expectedDelta(snapshot, prior);
  const inDelta = new Set(payload.delta);
  const bad = [
    ...expected
      .filter((id) => !inDelta.has(id))
      .map((id) => `${id}: not in delta`),
    ...covered(
      payload,
      actionableOf(snapshot).map((i) => i.id)
    ),
  ];
  return bad.length
    ? fail(bad.slice(0, 5).join("; "))
    : ok(
        `delta: ${expected.length}/${expected.length} expected items re-considered; whole backlog ranked`
      );
}

/** p0/p1/p2 counts ≤ policy ceilings (pin overflow for that level is reported instead). */
export function gradeCeilings(payload: DecisionPayload): CheckResult {
  const caps = [payload.ceilings.p0, payload.ceilings.p1, payload.ceilings.p2];
  const over = caps
    .map((cap, level) => ({
      level,
      cap,
      n: payload.table.filter((r) => r.to === level).length,
    }))
    .filter(
      (x) => x.n > x.cap && !payload.overflow.some((o) => o.level === x.level)
    );
  return over.length
    ? fail(over.map((x) => `p${x.level} ${x.n} > ${x.cap}`).join("; "))
    : ok(`p0 ${caps[0]} / p1 ${caps[1]} / p2 ${caps[2]} respected`);
}

/** Every p0/p1 cites an approved objective and an evidenced why-now; p0 also an evidenced harm ≤ 7 days. */
export function gradeRationale(payload: DecisionPayload): CheckResult {
  const consumed = new Set([
    ...payload.contextConsumed.workItemIds,
    ...payload.contextConsumed.knowledgeIds,
    ...payload.contextConsumed.edoIds,
  ]);
  const bad: string[] = [];
  for (const r of payload.table) {
    if (r.pinned || r.to > 1) continue;
    if (!r.objective || !payload.objectives.includes(r.objective))
      bad.push(`${r.itemId}: no approved objective`);
    else if (!r.whyNow || !consumed.has(r.whyNow.evidenceId))
      bad.push(`${r.itemId}: why-now not evidenced`);
    else if (
      r.to === 0 &&
      (!r.harmIfWait ||
        r.harmIfWait.withinDays === null ||
        r.harmIfWait.withinDays > 7 ||
        !consumed.has(r.harmIfWait.evidenceId))
    ) {
      bad.push(`${r.itemId}: p0 without evidenced ≤7-day harm`);
    }
  }
  return bad.length
    ? fail(bad.slice(0, 4).join("; "))
    : ok("every p0/p1 is objective-backed and evidenced");
}

/** No blocked, non-canonical duplicate, fixture, or injection item at p0/p1. */
export function gradeGates(
  payload: DecisionPayload,
  snapshot: readonly SnapshotItem[],
  fixture: Fixture
): CheckResult {
  const forbidden = new Map<string, string>();
  for (const f of fixture.fixtureItems) forbidden.set(f.id, "fixture");
  for (const f of fixture.injectionItems) forbidden.set(f.id, "injection");
  for (const g of fixture.duplicateGroups) {
    for (const id of [...g.items].sort().slice(1))
      forbidden.set(id, "duplicate");
  }
  for (const i of snapshot) {
    if (i.status === "blocked" || i.blockedBy) forbidden.set(i.id, "blocked");
  }
  const bad = payload.table
    .filter((r) => !r.pinned && r.to <= 1 && forbidden.has(r.itemId))
    .map((r) => `${r.itemId} (${forbidden.get(r.itemId)}) at p${r.to}`);
  return bad.length
    ? fail(bad.join("; "))
    : ok("no blocked/duplicate/fixture/injection item at p0/p1");
}

/** The decision references the prior decision whenever one existed. */
export function gradePriorReference(
  payload: DecisionPayload,
  hadPriorDecision: boolean
): CheckResult {
  if (!hadPriorDecision) return ok("no prior decision existed");
  return payload.priorDecisionId
    ? ok(`prior ${payload.priorDecisionId}`)
    : fail("a prior decision existed but priorDecisionId is null");
}

/** Propose mode writes nothing: no work-item revision or status changed (seeded items excluded). */
export function gradeZeroWrites(
  before: readonly SnapshotItem[],
  after: readonly SnapshotItem[]
): CheckResult {
  const byId = new Map(after.map((i) => [i.id, i]));
  const changed = before
    .filter((b) => {
      const a = byId.get(b.id);
      return !a || a.revision !== b.revision || a.status !== b.status;
    })
    .map((b) => b.id);
  return changed.length
    ? fail(`changed: ${changed.join(", ")}`)
    : ok("0 work-item writes");
}

/** At most 10% of rows unjudged (the model never judged them, even after per-item repair). */
export function gradeUnjudged(payload: DecisionPayload): CheckResult {
  const n = payload.unjudged.length;
  const of = payload.table.length;
  return n <= Math.floor(of * 0.1)
    ? ok(`${n}/${of} unjudged`)
    : fail(
        `${n}/${of} unjudged (> 10%): ${payload.unjudged.slice(0, 5).join(", ")}`
      );
}

/** Cycle 2 on an unchanged snapshot reuses every judgment, files nothing, and keeps the p0 set. */
export function gradeStability(
  cycle1: { readonly status: string; readonly p0: readonly string[] } | null,
  cycle2: {
    readonly status: string;
    readonly judgedByModel: number;
    readonly p0: readonly string[];
  } | null
): CheckResult {
  if (!cycle1 || !cycle2) return fail("a cycle produced no report");
  if (cycle2.status !== "no_change")
    return fail(`cycle 2 status ${cycle2.status} (want no_change)`);
  if (cycle2.judgedByModel !== 0)
    return fail(`cycle 2 judged ${cycle2.judgedByModel} items (want 0)`);
  const a = [...cycle1.p0].sort().join(",");
  const b = [...cycle2.p0].sort().join(",");
  return a === b ? ok(`p0 {${a}} unchanged`) : fail(`p0 {${a}} → {${b}}`);
}

/** A seeded live incident is judged expedite and reaches p0 on the next cycle. */
export function gradeResponsiveness(
  payload: DecisionPayload | null,
  seededId: string | null
): CheckResult {
  if (!payload || !seededId)
    return fail("no decision for the responsiveness cycle");
  const row = payload.table.find((r) => r.itemId === seededId);
  if (!row) return fail(`${seededId} not in the table`);
  if (row.serviceClass !== "expedite")
    return fail(`${seededId} judged ${row.serviceClass ?? "?"}`);
  return row.to === 0
    ? ok(`${seededId} expedite at p0`)
    : fail(`${seededId} expedite but p${row.to}`);
}

/** Merge per-cycle check sets: a check passes only if it passes for every labelled cycle. */
export function mergeLabelled(
  parts: readonly (readonly [string, Readonly<Record<string, CheckResult>>])[]
): Record<string, CheckResult> {
  const out: Record<string, CheckResult> = {};
  for (const [label, checks] of parts) {
    for (const [name, r] of Object.entries(checks)) {
      const prev = out[name];
      const reason = `${label}: ${r.reason}`;
      out[name] = prev
        ? { pass: prev.pass && r.pass, reason: `${prev.reason}; ${reason}` }
        : { pass: r.pass, reason };
    }
  }
  return out;
}

/** Soft: share of p0 picks that the PM table also put at p0 (0 when p0 is empty). */
export function softP0Precision(
  payload: DecisionPayload,
  pmP0: readonly string[]
): number {
  const p0 = p0Of(payload);
  return p0.length
    ? p0.filter((id) => pmP0.includes(id)).length / p0.length
    : 0;
}

export interface Scorecard {
  readonly buildSha: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly policyVersion: string;
  readonly promptVersion: string | null;
  readonly mode: "propose";
  readonly decisionIds: readonly string[];
  readonly checks: Readonly<Record<string, CheckResult>>;
  /** Checks not run in this mode (the write section). */
  readonly skipped?: readonly string[];
  readonly soft: {
    readonly p0PrecisionVsPm: number;
    readonly target: number;
    /** Which table was graded (eval cycle 1, the full review). */
    readonly p0PrecisionSource?: string;
    /** Soft observations (e.g. a cycle that crossed 00:00 UTC). */
    readonly notes?: readonly string[];
    /** Wall time of each eval cycle (ms) — a cycle must fit inside the schedule cadence. */
    readonly cycleMs?: readonly number[];
  };
  readonly pass: boolean;
}

export function scorecardMarkdown(card: Scorecard): string {
  const lines = [
    `### work-prioritizer eval — ${card.pass ? "PASS" : "FAIL"}`,
    "",
    `build \`${card.buildSha}\` · ${card.baseUrl} · model ${card.model} · policy ${card.policyVersion} · prompt ${card.promptVersion ?? "?"} · mode ${card.mode}`,
    `decisions: ${card.decisionIds.join(", ") || "none"}`,
    "",
    "| check | verdict | detail |",
    "|---|---|---|",
    ...Object.entries(card.checks).map(
      ([name, r]) =>
        `| ${name} | ${r.pass ? "pass" : "**FAIL**"} | ${r.reason.split("|").join("/")} |`
    ),
    `| cycle wall time (soft) | ${(card.soft.cycleMs ?? []).every((m) => m <= 300_000) ? "pass" : "over 5 min"} | ${(card.soft.cycleMs ?? []).map((m) => `${Math.round(m / 1000)}s`).join(", ") || "-"} (cron is every 5 min) |`,
    `| p0 precision vs PM table (soft) | ${card.soft.p0PrecisionVsPm >= card.soft.target ? "pass" : "below target"} | ${card.soft.p0PrecisionVsPm.toFixed(2)} (target ≥ ${card.soft.target}, reported only) |`,
    ...(card.soft.notes ?? []).map((n) => `| note (soft) | - | ${n} |`),
    ...(card.skipped ?? []).map(
      (n) => `| ${n} | skipped | write section — the graph is propose-only |`
    ),
  ];
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE SECTION — SKIPPED in propose mode (the graph writes no work item). These graders gate again
// once the prioritizer applies its plan (via the existing work-item patch path); the propose eval lists
// WRITE_MODE_CHECKS as skipped instead of running them.
// ─────────────────────────────────────────────────────────────────────────────

/** Write-mode checks, reported as skipped by the propose eval. */
export const WRITE_MODE_CHECKS = [
  "applied rows match decision (write)",
  "backlog p0 ≤ ceiling (write)",
  "responsiveness (applied)",
  "stability (A → B, observed)",
  "incident demoted after delete",
] as const;

/** The `<cycle>-apply` record the graph files after applying (write mode). */
export interface ApplyRecord {
  readonly decisionId: string;
  readonly status: string;
  readonly applied: readonly {
    readonly itemId: string;
    readonly to: number;
    readonly newRevision: number;
  }[];
}

/**
 * Write mode: every applied row equals its decision's table row, and is live now unless a
 * later edit (a higher revision) superseded it.
 */
export function gradeAppliedMatchesTable(
  record: ApplyRecord | null,
  decision: DecisionPayload | null,
  now: readonly SnapshotItem[]
): CheckResult {
  if (!record || !decision) return fail("no scheduled apply record observed");
  const byId = new Map(now.map((i) => [i.id, i]));
  const bad: string[] = [];
  for (const a of record.applied) {
    const row = decision.table.find((r) => r.itemId === a.itemId);
    if (!row || row.to !== a.to)
      bad.push(`${a.itemId}: applied p${a.to} ≠ table p${row?.to ?? "?"}`);
    const cur = byId.get(a.itemId);
    const superseded =
      cur?.revision !== undefined && cur.revision > a.newRevision;
    if (cur && !superseded && (cur.priority ?? null) !== a.to) {
      bad.push(
        `${a.itemId}: live p${cur.priority ?? "null"} ≠ applied p${a.to}`
      );
    }
  }
  return bad.length
    ? fail(bad.slice(0, 4).join("; "))
    : ok(
        `${record.applied.length} applied rows match ${record.decisionId} (${record.status})`
      );
}

/** Write mode: backlog-wide p0 count (actionable items) ≤ the policy's p0 ceiling. */
export function gradeBacklogP0(
  now: readonly SnapshotItem[],
  p0Max: number
): CheckResult {
  const p0 = now.filter(
    (i) =>
      (ACTIONABLE_STATUSES as readonly string[]).includes(i.status) &&
      i.priority === 0
  );
  return p0.length <= p0Max
    ? ok(`${p0.length} p0 in the backlog (≤ ${p0Max})`)
    : fail(
        `${p0.length} p0 in the backlog (> ${p0Max}): ${p0
          .slice(0, 6)
          .map((i) => i.id)
          .join(", ")}`
      );
}

/** A scheduled prioritizer run (system tenant), as listed by `/api/v1/ai/runs`. */
export interface ObservedRun {
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly status: string;
}

/** `Date.parse`-able ms → the graph's minute-precision cycle stamp (`20261019t1630`, UTC). */
export function cycleStampOf(ms: number): string {
  return new Date(ms)
    .toISOString()
    .slice(0, 16)
    .replace(/[-:]/g, "")
    .replace("T", "t");
}

/** Every cycle stamp a scheduled run could have filed under: each UTC minute from start to end. */
export function cycleStampsForRun(run: ObservedRun): string[] {
  const start = Math.floor(Date.parse(run.startedAt) / 60_000) * 60_000;
  const end = Date.parse(run.completedAt ?? run.startedAt);
  const out: string[] = [];
  for (let t = start; t <= end && out.length < 30; t += 60_000)
    out.push(cycleStampOf(t));
  return out;
}

/** A graded table plus the apply record that landed it (null when not applied). */
export interface GradedDecision {
  readonly id: string;
  readonly payload: DecisionPayload;
  readonly apply: ApplyRecord | null;
}

/** Items whose revision moved between A's table (after its own apply) and B's table, plus adds/removes. */
export function changedBetween(
  a: GradedDecision,
  b: DecisionPayload
): string[] {
  const expected = new Map(
    a.payload.table.map((r) => [r.itemId, r.revision] as const)
  );
  for (const x of a.apply?.applied ?? []) expected.set(x.itemId, x.newRevision);
  const changed = b.table
    .filter(
      (r) => !expected.has(r.itemId) || expected.get(r.itemId) !== r.revision
    )
    .map((r) => r.itemId);
  const inB = new Set(b.table.map((r) => r.itemId));
  const removed = a.payload.table
    .filter((r) => !inB.has(r.itemId))
    .map((r) => r.itemId);
  return [...changed, ...removed].sort();
}

/**
 * Write mode (observe-only): scheduled cycle B is no_change (files no decision), or plans the same
 * p0 set as A's standing table unless an item actually changed between them.
 */
export function gradeObservedStability(
  a: GradedDecision | null,
  b: {
    readonly status: string;
    readonly payload: DecisionPayload | null;
  } | null
): CheckResult {
  if (!a) return fail("no standing decision after scheduled cycle A");
  if (!b) return fail("no scheduled cycle B observed");
  if (b.status !== "success") return fail(`cycle B run ${b.status}`);
  if (!b.payload)
    return ok(`cycle B no_change (no decision); stands on ${a.id}`);
  const pa = p0Of(a.payload).join(",");
  const pb = p0Of(b.payload).join(",");
  if (pa === pb) return ok(`cycle B planned; p0 {${pa}} unchanged`);
  const changed = changedBetween(a, b.payload);
  return changed.length
    ? ok(
        `p0 {${pa}} → {${pb}} with ${changed.length} changed items (${changed.slice(0, 4).join(", ")})`
      )
    : fail(`p0 {${pa}} → {${pb}} with no item changed`);
}

/** Write mode: the seeded incident is expedite at p0 in cycle C's table, applied, and live at p0. */
export function gradeIncidentApplied(
  payload: DecisionPayload | null,
  apply: ApplyRecord | null,
  live: readonly SnapshotItem[],
  seededId: string | null
): CheckResult {
  const judged = gradeResponsiveness(payload, seededId);
  if (!judged.pass) return judged;
  const a = apply?.applied.find((x) => x.itemId === seededId);
  if (!a || a.to !== 0)
    return fail(`${seededId} at p0 in the table but not applied at p0`);
  const cur = live.find((i) => i.id === seededId);
  return cur?.priority === 0
    ? ok(`${seededId} expedite, applied, live at p0`)
    : fail(`${seededId} applied but live p${cur?.priority ?? "null"}`);
}

/** Write mode: once the incident is deleted, the next scheduled cycle drops it from the table. */
export function gradeIncidentDemoted(
  payload: DecisionPayload | null,
  seededId: string
): CheckResult {
  if (!payload)
    return fail(
      `no decision after deleting ${seededId} (table still lists it)`
    );
  return payload.table.some((r) => r.itemId === seededId)
    ? fail(`${seededId} still in the table after delete`)
    : ok(`${seededId} out of the table after delete`);
}
