// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/evals/work-prioritizer/run`
 * Purpose: Thin orchestration for the black-box work-prioritizer eval (propose mode): snapshot → invoke → load decision → score → report.
 * Scope: External lane (live node + API key + real model); not PR CI. Seeds and deletes one incident item; grading lives in score.ts.
 * Invariants:
 *   - FULL_REVIEW_ON_DEMAND: cycle 1 sends `fullReview: true`, so every run grades one full review (100% coverage)
 *     and then delta cycles (100% of the delta) on top of it.
 *   - OUTCOME_FROM_THE_GRAPH: each cycle's outcome is the `<prioritizer_report>` the graph pushes onto its own
 *     stream; `/api/v1/ai/runs` status is only the fallback. No log queries.
 *   - SCHEDULED_AT_SHA: the governance schedule must also have run the graph ≥ minScheduledCycles times at the SHA.
 *   - GOALS_FIRST: the node must have approved goals (listActiveGoals, read via the cognition bundle); none or
 *     unreadable ⇒ INCONCLUSIVE before any cycle.
 *   - EXIT_CODE_IS_VERDICT: exit 0 only when every hard + behavioral check passes; 1 = FAIL;
 *     3 = INCONCLUSIVE (no goal atoms, or the candidate's buildSha changed mid-eval — another flight evicted it).
 *   - WRITE_SECTION_SKIPPED: write-mode checks are listed as skipped (the graph is propose-only).
 *   - RESULTS_NOT_COMMITTED: `--out <file>` writes the JSON scorecard wherever the caller chooses.
 * Side-effects: IO (HTTP to the node; seeds + deletes one work item; optional --out file)
 * Links: evals/work-prioritizer/README.md, score.ts
 * @public
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import {
  type DecisionPayload,
  DecisionPayloadSchema,
} from "../../src/graphs/work-prioritizer/schema";
import {
  type CheckResult,
  type Fixture,
  gradeCoverage,
  gradeDeltaCoverage,
  gradeGates,
  gradeGoalCitation,
  gradeGoalsReported,
  gradeHarmEvidence,
  gradeP0Precision,
  gradePriorReference,
  gradeRationale,
  gradeResponsiveness,
  gradeStability,
  gradeUnjudged,
  gradeZeroWrites,
  mergeLabelled,
  p0Of,
  type Scorecard,
  type SnapshotItem,
  scorecardMarkdown,
  WRITE_MODE_CHECKS,
} from "./score";

interface Config {
  p0PrecisionTarget: number;
  runTimeoutMs: number;
  minScheduledCycles: number;
  scheduledWaitMs: number;
}

interface FixtureFile extends Fixture {
  incidentSeed: {
    type: string;
    title: string;
    summary: string;
    outcome: string;
  };
}

interface CycleReport {
  status: string;
  decisionId: string | null;
  judgedByModel: number;
  scope?: string | null;
  promptVersion?: string;
  goalIds?: string[];
}

interface Cycle {
  report: CycleReport | null;
  id: string | null;
  payload: DecisionPayload | null;
}

const DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(DIR, "../../../..");
const config = JSON.parse(
  readFileSync(path.join(DIR, "thresholds.json"), "utf8")
) as Config;
const fixture = JSON.parse(
  readFileSync(path.join(DIR, "fixture.json"), "utf8")
) as FixtureFile;

const BASE = (process.env.EVAL_BASE_URL ?? "https://test.cognidao.org").replace(
  /\/$/,
  ""
);
const KEY = process.env.EVAL_API_KEY ?? process.env.COGNI_CANDIDATE_API_KEY;
const MODEL = process.env.EVAL_MODEL ?? "gpt-oss-120b";
const argOf = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const OUT = argOf("--out");
/** The SHA under test — pinned by the caller, never read from live /version. */
const EXPECTED_SHA = process.env.EVAL_EXPECTED_SHA ?? argOf("--sha");
/** When the SHA landed on the candidate (ISO); scheduled cycles are counted from here. */
const LANDED_AT = process.env.EVAL_LANDED_AT ?? argOf("--landed-at");

if (!KEY || !EXPECTED_SHA) {
  console.error(
    "EVAL_API_KEY|COGNI_CANDIDATE_API_KEY and EVAL_EXPECTED_SHA (or --sha <sha>) are required"
  );
  process.exit(2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `${init?.method ?? "GET"} ${pathname} → ${res.status}: ${text.slice(0, 300)}`
    );
  return (text ? JSON.parse(text) : {}) as T;
}

/** The operator repo-spec policy, sent exactly as the governance schedule sends it. */
function loadPolicy() {
  const spec = parseYaml(
    readFileSync(
      path.join(REPO, "nodes/operator/.cogni/repo-spec.yaml"),
      "utf8"
    )
  ) as {
    work_prioritization: { policy_version: string };
  };
  const policy = { policyVersion: spec.work_prioritization.policy_version };
  const trigger = (extra: Record<string, unknown> = {}) =>
    `PRIORITIZE\n\n\`\`\`json\n${JSON.stringify({ workPrioritization: policy, ...extra })}\n\`\`\``;
  return { policy, trigger };
}

async function snapshot(): Promise<SnapshotItem[]> {
  const out: SnapshotItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 40; page++) {
    const q = `/api/v1/work/items?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const body = await api<{ items: SnapshotItem[]; nextCursor?: string }>(q);
    out.push(...body.items);
    if (!body.nextCursor) return out;
    cursor = body.nextCursor;
  }
  throw new Error("snapshot exceeded 40 pages");
}

async function decisionIds(): Promise<{ id: string; createdAt?: string }[]> {
  const body = await api<{ items: { id: string; createdAt?: string }[] }>(
    "/api/v1/knowledge?domain=operator"
  );
  return body.items
    .filter((e) => /^work-prioritizer-\d{8}t\d{4}-decision$/.test(e.id))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/**
 * The node's active goal ids from the same reader the graph uses (`listActiveGoals`), as rendered in the
 * cognition bundle's `## Goals` section (`By: … · \`goal-…\``). An unreadable list is INCONCLUSIVE.
 */
async function nodeGoalIds(): Promise<string[]> {
  const { markdown } = await api<{ markdown: string }>("/api/v1/cognition");
  const section = markdown.split(/^## Goals\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  if (/goals unavailable:/.test(section))
    throw new InconclusiveError(`node goals unreadable: ${section.trim()}`);
  return [...section.matchAll(/`(goal-[a-z0-9][a-z0-9-]*)`/g)].map(
    (m) => m[1] as string
  );
}

/** A hub entry's content, or null when the entry does not exist (404). */
async function entryContent(id: string): Promise<string | null> {
  const res = await fetch(
    `${BASE}/api/v1/knowledge/${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${KEY}` } }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET knowledge ${id} → ${res.status}`);
  return ((await res.json()) as { content?: string }).content ?? "";
}

async function loadDecision(
  id: string | null
): Promise<DecisionPayload | null> {
  if (!id) return null;
  const m = /```json\s*([\s\S]*?)```/.exec((await entryContent(id)) ?? "");
  const parsed = DecisionPayloadSchema.safeParse(JSON.parse(m?.[1] ?? "null"));
  return parsed.success ? parsed.data : null;
}

const cycleMs: number[] = [];

/** Invoke one cycle; the graph's own report from the stream (fallback: run status + newest decision). */
async function invoke(trigger: string): Promise<CycleReport | null> {
  const since = Date.now();
  let text = "";
  try {
    const res = await fetch(`${BASE}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        graph_name: "work-prioritizer",
        stream: true,
        messages: [{ role: "user", content: trigger }],
      }),
    });
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    // stream dropped — fall back below
  }
  const content = text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => {
      try {
        const d = JSON.parse(l.slice(6)) as {
          choices?: { delta?: { content?: string } }[];
        };
        return d.choices?.[0]?.delta?.content ?? "";
      } catch {
        return "";
      }
    })
    .join("");
  const m = /<prioritizer_report>([\s\S]*?)<\/prioritizer_report>/.exec(
    content
  );
  if (m?.[1]) return JSON.parse(m[1]) as CycleReport;

  const deadline = Date.now() + config.runTimeoutMs;
  while (Date.now() < deadline) {
    const { runs } = await api<{
      runs: { graphId: string; status: string; startedAt: string }[];
    }>("/api/v1/ai/runs?limit=20");
    const run = runs.find(
      (r) =>
        r.graphId === "langgraph:work-prioritizer" &&
        Date.parse(r.startedAt) >= since - 5_000
    );
    if (run && run.status !== "running" && run.status !== "pending") {
      const newest = (await decisionIds())[0];
      const fresh = newest?.createdAt && Date.parse(newest.createdAt) >= since;
      return run.status === "success" && fresh
        ? { status: "planned", decisionId: newest.id, judgedByModel: -1 }
        : null;
    }
    await sleep(10_000);
  }
  return null;
}

/**
 * One SHA-guarded cycle and the decision it stands for: its own (planned) or the standing newest
 * (no_change). A `stale_prior` (a scheduled cycle filed first) is retried once.
 */
async function cycle(underTest: string, trigger: string): Promise<Cycle> {
  let report: CycleReport | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assertSha(underTest);
    const t0 = Date.now();
    report = await invoke(trigger);
    cycleMs.push(Date.now() - t0);
    await assertSha(underTest);
    if (report?.status !== "stale_prior") break;
  }
  const id =
    report?.status === "planned"
      ? report.decisionId
      : report?.status === "no_change"
        ? ((await decisionIds())[0]?.id ?? null)
        : null;
  return { report, id, payload: await loadDecision(id) };
}

/** Successful scheduled (system tenant) prioritizer runs started at/after `since`. */
async function scheduledRuns(since: number): Promise<number> {
  const { runs } = await api<{
    runs: { graphId: string; status: string; startedAt: string }[];
  }>("/api/v1/ai/runs?scope=system&runKind=system_scheduled&limit=100");
  return runs.filter(
    (r) =>
      r.graphId === "langgraph:work-prioritizer" &&
      r.status === "success" &&
      Date.parse(r.startedAt) >= since
  ).length;
}

/** The SHA under test was not what we measured, or the node cannot be measured yet — never a FAIL. */
class InconclusiveError extends Error {}

/** EVICTION_GUARD: the SHA under test must still be live; otherwise the run is inconclusive. */
async function assertSha(underTest: string): Promise<void> {
  const v = (await fetch(`${BASE}/version`)
    .then((r) => r.json())
    .catch(() => ({}))) as { buildSha?: string };
  const sha = v.buildSha ?? "unknown";
  if (sha !== underTest)
    throw new InconclusiveError(
      `candidate evicted at ${new Date().toISOString()} by ${sha}`
    );
}

/** The hard checks every filed decision must pass (coverage is graded per cycle kind). */
/** The hard checks every filed decision must pass (coverage is graded per cycle kind). */
function hardChecks(
  payload: DecisionPayload,
  snap: readonly SnapshotItem[],
  hadPrior: boolean
): Record<string, CheckResult> {
  return {
    "goal citation": gradeGoalCitation(payload),
    rationale: gradeRationale(payload),
    gates: gradeGates(payload, snap, fixture),
    "prior reference": gradePriorReference(payload, hadPrior),
    unjudged: gradeUnjudged(payload),
  };
}

const none = (reason: string): CheckResult => ({ pass: false, reason });
const HARD = [
  "goal citation",
  "rationale",
  "gates",
  "prior reference",
  "unjudged",
];
const allNone = (reason: string) =>
  Object.fromEntries(HARD.map((k) => [k, none(reason)]));

async function runEval(underTest: string): Promise<void> {
  const startedAt = Date.now();
  await assertSha(underTest); // EXPECTED_SHA must be live before anything runs
  const { policy, trigger } = loadPolicy();
  const landedAt = LANDED_AT ? Date.parse(LANDED_AT) : startedAt;
  const goalIds = await nodeGoalIds();
  if (goalIds.length === 0)
    throw new InconclusiveError(
      `no approved goals on ${BASE} (cognition: no approved goals) — seed the node's goal-* atoms first`
    );
  const notes: string[] = [];
  const before = await snapshot();
  const hadPrior = (await decisionIds()).length > 0;

  // Cycle 1: a requested full review. Cycle 2 (same snapshot, 61 s later — cycle ids are per minute):
  // a delta cycle that must carry every judgment and file nothing.
  const c1 = await cycle(underTest, trigger({ fullReview: true }));
  await sleep(61_000);
  const c2 = await cycle(underTest, trigger());
  const afterStability = await snapshot();
  if (c2.report?.scope === "full")
    notes.push("cycle 2 crossed 00:00 UTC and ran as a full review");

  // Cycle 3: seed a live incident (a new item ⇒ in the delta), run one delta cycle, always delete it.
  await sleep(61_000);
  const seeded = await api<{ id: string }>("/api/v1/work/items", {
    method: "POST",
    body: JSON.stringify(fixture.incidentSeed),
  });
  let c3: Cycle = { report: null, id: null, payload: null };
  let seededSnap: SnapshotItem[] = [];
  try {
    seededSnap = await snapshot();
    c3 = await cycle(underTest, trigger());
  } finally {
    await api(`/api/v1/work/items/${seeded.id}`, { method: "DELETE" }).catch(
      (e) => console.error(`cleanup ${seeded.id}: ${String(e)}`)
    );
  }
  const c3Prior = await loadDecision(c3.payload?.priorDecisionId ?? null);

  // SCHEDULED_AT_SHA: wait (SHA-guarded) until the schedule has run the graph enough times at the SHA.
  let scheduled = await scheduledRuns(landedAt);
  const waitUntil = Date.now() + config.scheduledWaitMs;
  while (scheduled < config.minScheduledCycles && Date.now() < waitUntil) {
    await assertSha(underTest);
    await sleep(20_000);
    scheduled = await scheduledRuns(landedAt);
  }
  await assertSha(underTest);

  const checks: Record<string, CheckResult> = {
    "coverage (full review, cycle 1)": c1.payload
      ? gradeCoverage(c1.payload, before)
      : none("no decision (cycle 1)"),
    "coverage (delta, cycle 3)": c3.payload
      ? gradeDeltaCoverage(c3.payload, c3Prior, seededSnap)
      : none("no decision (cycle 3)"),
    ...mergeLabelled([
      [
        "c1",
        c1.payload
          ? hardChecks(c1.payload, before, hadPrior)
          : allNone("no decision (cycle 1)"),
      ],
      [
        "c3",
        c3.payload
          ? hardChecks(c3.payload, seededSnap, true)
          : allNone("no decision (cycle 3)"),
      ],
    ]),
    no_goals: gradeGoalsReported(
      c1.report?.goalIds ?? c1.payload?.goals ?? [],
      goalIds
    ),
    "zero writes (propose)": gradeZeroWrites(before, afterStability),
    "stability (2 cycles)": gradeStability(
      c1.report && c1.payload
        ? { status: c1.report.status, p0: p0Of(c1.payload) }
        : null,
      c2.report && c2.payload
        ? {
            status: c2.report.status,
            judgedByModel: c2.report.judgedByModel,
            p0: p0Of(c2.payload),
          }
        : null
    ),
    "harm evidence (full review)": c1.payload
      ? gradeHarmEvidence(c1.payload, fixture.pmLabels.p0)
      : none("no decision (cycle 1)"),
    "p0 overlap with PM (full review)": c1.payload
      ? gradeP0Precision(
          c1.payload,
          fixture.pmLabels.p0,
          config.p0PrecisionTarget
        )
      : none("no decision (cycle 1)"),
    responsiveness: gradeResponsiveness(c3.payload, seeded.id),
    [`scheduled cycles at SHA ≥ ${config.minScheduledCycles}`]: {
      pass: scheduled >= config.minScheduledCycles,
      reason: `${scheduled} successful scheduled cycles since ${new Date(landedAt).toISOString()}`,
    },
  };
  const card: Scorecard = {
    buildSha: underTest,
    baseUrl: BASE,
    model: MODEL,
    policyVersion: policy.policyVersion,
    promptVersion:
      c1.payload?.promptVersion ?? c1.report?.promptVersion ?? null,
    mode: "propose",
    decisionIds: [c1.id, c2.id, c3.id].filter((x): x is string => Boolean(x)),
    checks,
    skipped: [...WRITE_MODE_CHECKS],
    soft: { cycleMs, notes },
    pass: Object.values(checks).every((c) => c.pass),
  };
  console.log(scorecardMarkdown(card));
  if (OUT) writeFileSync(OUT, `${JSON.stringify(card, null, 2)}\n`);
  process.exit(card.pass ? 0 : 1);
}

async function main(): Promise<void> {
  const underTest = EXPECTED_SHA as string;
  try {
    await runEval(underTest);
  } catch (error) {
    if (!(error instanceof InconclusiveError)) throw error;
    // Never FAIL on eviction or missing goals — the SHA under test was not what we measured.
    const line = `INCONCLUSIVE: ${error.message} (SHA under test ${underTest})`;
    console.log(line);
    if (OUT)
      writeFileSync(
        OUT,
        `${JSON.stringify({ buildSha: underTest, inconclusive: line }, null, 2)}\n`
      );
    process.exit(3);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
