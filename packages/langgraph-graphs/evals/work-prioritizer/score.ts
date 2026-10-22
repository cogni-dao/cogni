// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/evals/work-prioritizer/score`
 * Purpose: Pure graders for the work-prioritizer eval: each check returns pass/fail plus a reason.
 * Scope: Pure functions over decision payloads, snapshots, and the fixture; does not perform IO.
 * Invariants:
 *   - GRADERS_ARE_PURE: same input → same verdict; unit-tested in tests/evals/work-prioritizer.score.test.ts.
 *   - GATE = every hard + behavioral check passes; informational rows are reported only.
 *   - PROPOSE_GATE: the eval's own (API) cycles never write; that gate is unchanged.
 *   - WRITE_SECTION (story.5108): only when the env applies — a scheduled cycle's plan is read back from the live
 *     store: p2–p4 rows landed (or lost a compare-and-set to another writer), and no row touching p0/p1 (from or
 *     to ≤ 1 — proposal-only, node-admin territory) was written.
 * Side-effects: none
 * Links: evals/work-prioritizer/README.md, run.ts
 * @public
 */

import type { DecisionPayload } from "../../src/graphs/work-prioritizer/schema";

export interface SnapshotItem {
  readonly id: string;
  readonly status: string;
  readonly revision?: number;
  readonly blockedBy?: string;
  readonly priority?: number | null;
  readonly rank?: number | null;
}

export interface Fixture {
  readonly duplicateGroups: readonly { readonly items: readonly string[] }[];
  readonly injectionItems: readonly { readonly id: string }[];
  readonly fixtureItems: readonly { readonly id: string }[];
  /** A PM p0 oracle and the goal set it was authored for (informational only). */
  readonly pmLabels: {
    readonly p0: readonly string[];
    readonly goals: readonly string[];
  };
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

/** Every p0/p1 has an evidenced why-now; a p0 also an evidenced harm ≤ 7 days. */
export function gradeRationale(payload: DecisionPayload): CheckResult {
  const consumed = new Set([
    ...payload.contextConsumed.workItemIds,
    ...payload.contextConsumed.knowledgeIds,
    ...payload.contextConsumed.edoIds,
  ]);
  const bad: string[] = [];
  for (const r of payload.table) {
    if (r.to > 1) continue;
    if (!r.whyNow || !consumed.has(r.whyNow.evidenceId))
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
    : ok("every p0/p1 is evidenced");
}

const GOAL_ID = /^goal-[a-z0-9][a-z0-9-]*$/;

/**
 * NO_GOALS / ONE_GOAL_LIST (live half — the zero-goal path is unit-tested): the cycle reports the goal ids it
 * ranked against; they are non-empty, all `goal-*`, and all active goal atoms on the node.
 */
export function gradeGoalsReported(
  goalIds: readonly string[],
  nodeGoalIds: readonly string[]
): CheckResult {
  const bad = goalIds.filter(
    (g) => !GOAL_ID.test(g) || !nodeGoalIds.includes(g)
  );
  if (goalIds.length === 0) return fail("the cycle reported no goal ids");
  return bad.length
    ? fail(`not active goal-* atoms: ${bad.join(", ")}`)
    : ok(`ranked against ${goalIds.join(", ")}`);
}

/** P0P1_CITES_GOAL: every p0/p1 row carries `goal: goal-<slug>` from the cycle's active goal set. */
export function gradeGoalCitation(payload: DecisionPayload): CheckResult {
  const bad = payload.table
    .filter((r) => r.to <= 1)
    .filter(
      (r) => !r.goal || !GOAL_ID.test(r.goal) || !payload.goals.includes(r.goal)
    )
    .map((r) => `${r.itemId} at p${r.to} cites ${r.goal ?? "no goal"}`);
  const p0p1 = payload.table.filter((r) => r.to <= 1).length;
  return bad.length
    ? fail(bad.slice(0, 4).join("; "))
    : ok(`${p0p1} p0/p1 rows, each citing one of ${payload.goals.join(", ")}`);
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
    .filter((r) => r.to <= 1 && forbidden.has(r.itemId))
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

/** How one scheduled-cycle plan row reads back from the live store (WRITE_SECTION). */
export type ApplyReadBack = "landed" | "conflict" | "missed" | "gone";

/**
 * `landed`: the live item shows the row's priority + rank at a newer revision. `missed`: still at the snapshot
 * revision without the row's values (nobody wrote — the apply did not happen). `conflict`: another writer moved
 * the revision first (a lost compare-and-set, or a later overwrite). `gone`: no longer in the backlog.
 */
export function readBackRow(
  row: DecisionPayload["plan"][number],
  live: SnapshotItem | undefined
): ApplyReadBack {
  if (!live) return "gone";
  const newer =
    live.revision !== undefined &&
    row.expectedRevision !== null &&
    live.revision > row.expectedRevision;
  if (newer && live.priority === row.to && live.rank === row.rank)
    return "landed";
  return newer ? "conflict" : "missed";
}

/** A plan row the graph may write: neither from nor to is p0/p1 (P0P1_IS_PROPOSAL_ONLY). */
const writable = (r: DecisionPayload["plan"][number]) =>
  r.to >= 2 && (r.from === null || r.from >= 2);

/** WRITE_SECTION: every changed p2–p4 row of the scheduled plan landed or lost its CAS to another writer. */
export function gradeAppliedRows(
  payload: DecisionPayload,
  live: readonly SnapshotItem[]
): CheckResult {
  const byId = new Map(live.map((i) => [i.id, i]));
  const rows = payload.plan.filter(writable);
  if (rows.length === 0)
    return fail(
      "the scheduled plan has no p2–p4 rows — write path unexercised"
    );
  const n = { landed: 0, conflict: 0, missed: 0, gone: 0 };
  const missed: string[] = [];
  for (const r of rows) {
    const k = readBackRow(r, byId.get(r.itemId));
    n[k] += 1;
    if (k === "missed")
      missed.push(`${r.itemId} (want p${r.to} rank ${r.rank})`);
  }
  const counts = `${n.landed} landed · ${n.conflict} conflict · ${n.gone} gone · ${n.missed} missed of ${rows.length}`;
  if (missed.length) return fail(`${counts}: ${missed.slice(0, 5).join(", ")}`);
  return n.landed > 0 ? ok(counts) : fail(`${counts} — no p2–p4 write landed`);
}

/**
 * WRITE_SECTION: no plan row touching p0/p1 (currently p0/p1, or proposed p0/p1) was written: the item is still
 * at the snapshot revision, or moved without taking the row's values (another writer).
 */
export function gradeNoP0P1Writes(
  payload: DecisionPayload,
  live: readonly SnapshotItem[]
): CheckResult {
  const byId = new Map(live.map((i) => [i.id, i]));
  const rows = payload.plan.filter((r) => !writable(r));
  const landed = rows
    .filter((r) => readBackRow(r, byId.get(r.itemId)) === "landed")
    .map((r) => `${r.itemId} p${r.from ?? "-"} → p${r.to}`);
  return landed.length
    ? fail(`p0/p1 rows written (must stay proposals): ${landed.join(", ")}`)
    : ok(
        `0/${rows.length} p0/p1 plan rows written (proposal-only for the node admin)`
      );
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

/**
 * INFORMATIONAL (never a gate — an empty p0 is a correct answer): how many of the PM's p0 oracle items the
 * full review put at p0, and whether the oracle was authored for the goals the run actually used.
 */
export function infoPmOverlap(
  payload: DecisionPayload,
  pm: Fixture["pmLabels"]
): CheckResult {
  const p0 = p0Of(payload);
  const hits = pm.p0.filter((id) => p0.includes(id));
  const sameGoals =
    pm.goals.length === payload.goals.length &&
    pm.goals.every((g) => payload.goals.includes(g));
  const scope = sameGoals
    ? "oracle authored for these goals"
    : `oracle authored for other goals {${pm.goals.join(", ")}}`;
  return ok(
    `${hits.length}/${pm.p0.length} of {${pm.p0.join(", ")}} at p0 (${hits.join(", ") || "none"}); ${scope}`
  );
}

/** INFORMATIONAL: the full review's level counts. */
export function infoLevelCounts(payload: DecisionPayload): CheckResult {
  const n = (l: number) => payload.table.filter((r) => r.to === l).length;
  return ok(`p0 ${n(0)} · p1 ${n(1)} · p2 ${n(2)} · p3 ${n(3)} · p4 ${n(4)}`);
}

/**
 * The decision a cycle report stands for: the one it filed (planned), else the standing decision it was
 * planned against (no_change: the report's prior reference, else the caller's fallback — cycle 1's id).
 */
export function standingDecisionId(
  report: {
    readonly status: string;
    readonly decisionId: string | null;
    readonly priorDecisionId?: string | null;
  } | null,
  fallback: string | null
): string | null {
  if (report?.status === "planned") return report.decisionId;
  if (report?.status === "no_change") return report.priorDecisionId ?? fallback;
  return null;
}

/**
 * INFORMATIONAL (regression signal for the lost-harm parse): how many full-review judgments carry real harm
 * evidence. Not a gate — an empty p0 is a correct answer.
 */
export function gradeHarmEvidence(
  payload: DecisionPayload,
  pmP0: readonly string[]
): CheckResult {
  if (pmP0.length === 0) return ok("no PM p0 labels — not applicable");
  const harmed = payload.judgments.filter(
    (j) => j.judgment.harmIfWait.text !== "none"
  );
  const timed = harmed.filter((j) => j.judgment.harmIfWait.withinDays !== null);
  return harmed.length
    ? ok(
        `${harmed.length}/${payload.judgments.length} judgments carry harm (${timed.length} with harmDays)`
      )
    : fail(
        `0/${payload.judgments.length} judgments carry harm evidence (every harmIfWait is "none")`
      );
}

/**
 * READ_AFTER_WRITE: re-run `read` every `intervalMs` until it returns non-null or `timeoutMs` elapses;
 * returns the last result (null on timeout). `sleep`/`now` are injectable so the bound is unit-tested.
 */
export async function pollUntil<T>(
  read: () => Promise<T | null>,
  opts: {
    readonly timeoutMs: number;
    readonly intervalMs: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
  }
): Promise<T | null> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null || now() >= deadline) return value;
    await sleep(opts.intervalMs);
  }
}

export interface Scorecard {
  readonly buildSha: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly promptVersion: string | null;
  readonly mode: "propose" | "apply";
  readonly decisionIds: readonly string[];
  readonly checks: Readonly<Record<string, CheckResult>>;
  /** Informational rows — reported, never gating. */
  readonly info?: Readonly<Record<string, CheckResult>>;
  readonly soft: {
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
    `build \`${card.buildSha}\` · ${card.baseUrl} · model ${card.model} · prompt ${card.promptVersion ?? "?"} · mode ${card.mode}`,
    `decisions: ${card.decisionIds.join(", ") || "none"}`,
    "",
    "| check | verdict | detail |",
    "|---|---|---|",
    ...Object.entries(card.checks).map(
      ([name, r]) =>
        `| ${name} | ${r.pass ? "pass" : "**FAIL**"} | ${r.reason.split("|").join("/")} |`
    ),
    ...Object.entries(card.info ?? {}).map(
      ([name, r]) => `| ${name} | info | ${r.reason.split("|").join("/")} |`
    ),
    `| cycle wall time (soft) | ${(card.soft.cycleMs ?? []).every((m) => m <= 300_000) ? "pass" : "over 5 min"} | ${(card.soft.cycleMs ?? []).map((m) => `${Math.round(m / 1000)}s`).join(", ") || "-"} (soft budget 5 min per cycle) |`,
    ...(card.soft.notes ?? []).map((n) => `| note (soft) | - | ${n} |`),
  ];
  return lines.join("\n");
}
