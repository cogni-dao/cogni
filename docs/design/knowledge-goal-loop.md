---
id: knowledge-goal-loop
type: design
title: "Knowledge Goal Loop — a self-terminating AI goal + KPI primitive on the EDO plane"
status: draft
spec_refs:
  - knowledge-syntropy
work_items: []
created: 2026-06-11
---

# Knowledge Goal Loop

> Derek's words: _"a super-simple primitive for an AI goal + KPI, where our temporal
> langgraph schedule loop runs on it, with the knowledge + refs + kpi calculated +
> evolving underneath. and the AI loops until it either proves it's hit its goal,
> or it reaches the end of its budget + recursive allotment."_

This design adds **zero new tables and zero new primitives.** A goal is a
`hypothesis` row; its KPI is the existing `resolution_strategy` column; its proof
is the existing citation DAG; its confidence is the existing computed-confidence
formula. The only genuinely new thing is a **bounded loop controller** (a Temporal
schedule wrapping one langgraph node) plus the thin `metric:<kpi-id>` convention
and a `LoopBudget` that guarantees termination.

The seam in this PR is `packages/knowledge-store/src/domain/goal-loop.ts`
(types + the `metric:` convention + the pure halt predicate). The controller,
the KPI reader, and the Temporal/langgraph wiring are **deferred to a follow-up
`/implement`** after this design is reviewed.

---

## Why reuse `hypothesis`, NOT a new `goal` entry_type

The spec's own rule (`knowledge-syntropy.md` § "When to Create New Tables"):

> _If the entry_type needs more than 3 columns that other entry_types don't
> have, it's probably a new table; else add an entry_type._

A goal needs exactly three things beyond what a `hypothesis` already carries:
a **KPI binding**, a **target threshold**, and a **loop budget**. A `hypothesis`
already gives us all the load-bearing structure for free:

| Goal needs                          | `hypothesis` already provides                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| A falsifiable success condition     | `entry_type='hypothesis'` IS a falsifiable prediction (`HYPOTHESIS_HAS_EVALUATE_AT`)          |
| An appointment with truth           | `evaluate_at` — the hard wall-clock stop                                                       |
| A way to declare "resolve me by X"  | `resolution_strategy` — already namespaced text, already regex-admits `metric:<id>`           |
| Proof that accumulates              | the `citations` DAG (`evidence_for` from each loop step)                                       |
| A closing verdict                   | the `outcome` row + `validates`/`invalidates` edge (already enforced atomically)              |
| Confidence that evolves with proof  | `recomputeConfidence` (1-hop, pure-from-citations) already runs on every resolving edge        |

So a goal is **a hypothesis with a `metric:` resolution_strategy.** The prediction
it makes is _"a bounded loop can drive `kpi >= target` before `evaluate_at`."_ The
loop's atoms are the evidence; the outcome row is the verdict. Introducing a `goal`
entry_type would fork `EntryTypeSchema`, force a parallel set of read-filters
(`SCHEMA_REFINED_BY_READ_FILTER` already lists the four EDO types), and buy nothing
— a goal is structurally a hypothesis whose resolution happens to be agent-driven
and metric-gated. **Verdict: reuse `hypothesis`. No taxonomy change, no migration.**

The three goal-specific fields ride existing columns, NOT new ones:

- **KPI binding** → `resolution_strategy = metric:<kpi-id>` (see below).
- **target + budget** → `tags` JSON keys on the hypothesis row
  (`goal.target`, `goal.budget.*`). `tags` is shipped `jsonb` typed `string[]`;
  v0 encodes the two values as a pair of `key=value` tag strings
  (`goal-target=80`, `goal-max-iterations=5`, …) so we read them with a `LIKE`
  scan and never touch Doltgres's broken JSONB operators. The typed `Goal`
  projection (`GoalSchema`) is what the controller actually consumes — `tags`
  is just the wire encoding.

---

## KPI + threshold via `resolution_strategy`

The KPI binding is a **value** of the existing `resolution_strategy` column, not a
new column. The shipped regex —

```
/^[a-z][a-z0-9_]*(:[A-Za-z0-9_./~^-]+)?$/
```

— already admits `metric:oss-frontier-coverage`. Per
`RESOLUTION_STRATEGY_NULL_MEANS_MANUAL`, adding the `metric:` kind is a
**code change (one Zod refinement), never a schema migration.**

**The value after `metric:` is a KPI _identifier_, not an inline query.** The regex
forbids parens and spaces, so `metric:rate(...)` is illegal by construction — and
that is the right constraint: a KPI id is versioned + reusable; an inline
expression smeared across rows is not. The deferred **KPI reader** maps the id → a
0–100 number (same scale as `confidence_pct` and `target`).

```
hypothesis row
  entry_type          = 'hypothesis'
  evaluate_at         = <hard wall-clock stop>
  resolution_strategy = 'metric:oss-frontier-coverage'   ← KPI binding
  tags                = ['goal-target=80', 'goal-max-iterations=5',
                         'goal-max-tokens=200000', 'goal-max-recursion-depth=1']
```

The resolver cron already reads pending rows by `evaluate_at` and dispatches by
`resolution_strategy` namespace (`PendingResolutionsOptions.strategy` takes a
`"metric:"` prefix). A `metric:`-strategy goal is dispatched to the loop
controller instead of the generic `agent` resolver.

---

## The KPI reader MUST be verifier-independent (worker ≠ verifier)

This is the **load-bearing invariant** (`KPI_VERIFIER_INDEPENDENT`) and where a
naïve version of this primitive goes wrong. The frontier consensus is unambiguous:

- **Claude Code `/goal`** runs the worker until a **separate evaluator model**
  (Haiku) judges the completion condition — deliberately splitting "the agent that
  works from the one that decides it's done."
- **Reflexion / self-eval research** shows self-grading **fails when the verifier
  shares the worker's blind spot** — an agent that judges its own success against
  its own knowledge inherits its own gaps.
- **AgentPRM** scores *Progress* explicitly to kill steps that look locally good but
  lead nowhere.

The trap for THIS design: the loop's whole job is to file `evidence_for` edges to
its own hypothesis, and each supporting edge bumps `confidence_pct` (`+10`, cap
`+50`). So **if `kpi == confidence_pct(hypothesisId)`, the loop hits its target by
the _volume_ of its own self-authored evidence — not by independent truth.** A goal
could "succeed" having proven nothing.

**Rule:** the KPI reader is **independent of the loop's own writes.** Valid v0
readers:

| KPI reader | Independent? | Notes |
| ---------- | ------------ | ----- |
| External metric (a real number the loop does not author — DB count, coverage %, market price) | ✅ | the target shape |
| A **separate verifier/judge** — the **librarian** role reads the chain + grades it (the worker is the **storage-expert** role; Cogni already splits these) | ✅ | reuses the existing role split, mirrors `/goal`'s Haiku evaluator |
| Held-out check (a test the worker can't see) | ✅ | strongest |
| The goal's own `confidence_pct` | ❌ | **smoke-test only** — proves the loop _turns_, never that a goal is _met_. Must never gate a real goal. |

The worker writes evidence; a different reader scores the KPI. `loopHaltReason`
consumes `lastKpi` as an opaque 0–100 — it does not care who computed it, but the
controller MUST wire it to an independent reader, not to `recomputeConfidence` of
the row the loop is writing to.

---

## The loop controller

One **Temporal schedule** wrapping one **langgraph node**, mirroring the existing
`scheduler-worker` + `GraphRunWorkflow` pattern (NOT a new orchestration tool —
Temporal is already the schedule plane; langgraph is already the agent plane).

```
Temporal schedule (per goal, keyed on hypothesisId)
   │  each tick:
   ▼
┌─────────────────────────────────────────────────────────────┐
│ GoalLoopWorkflow(hypothesisId)                               │
│  1. load Goal (hypothesis row → GoalSchema projection)       │
│  2. read current KPI (kpiId → 0–100)                         │
│  3. loopHaltReason(state, now)  ── LOOP_TERMINATES, first    │
│        ├─ goal_met            → file outcome (validates), stop│
│        ├─ evaluate_at_passed  → file outcome (invalidates)    │
│        ├─ *_exhausted         → file outcome (invalidates)    │
│        └─ null → take ONE step:                              │
│             langgraph node researches / writes ONE linked    │
│             atom via core__knowledge_write `cite` op         │
│             (evidence_for → the goal hypothesis), or files a │
│             core__edo_decide. Accumulate tokens.             │
│  4. recompute KPI; re-arm next tick (or stop on halt)        │
└─────────────────────────────────────────────────────────────┘
```

Each iteration files **one linked atom** — a finding/scorecard that
`evidence_for`s the goal hypothesis via the generic `cite` op (PR #1614). That is
the whole syntropy payoff: **the loop's work product IS the evidence**, the KPI +
confidence **evolve from the accumulating citations**, and the chain is browsable
on `/knowledge?mode=chains` with no extra bookkeeping. When the loop halts it files
exactly one `outcome` row via `core__edo_record_outcome`, with the
`validates`/`invalidates` edge chosen by `haltEdge(reason)` — which triggers the
existing `recomputeConfidence` on the hypothesis. The loop never invents state; it
walks the EDO beats that already exist.

**No new persisted loop state.** Iteration history is the citation chain on the
hypothesis. The only transient is `LoopState` (budget accounting) threaded through
the Temporal workflow run.

---

## The budget + recursive-allotment guard (LOOP_TERMINATES)

The simplest thing that provably terminates: three independent caps, checked FIRST
each tick, halt on the first exhausted axis. This is `LoopBudget` in the seam file.

| Axis                | Field               | v0 default | Bounds                                          |
| ------------------- | ------------------- | ---------- | ----------------------------------------------- |
| Iterations          | `maxIterations`     | `5`        | total Temporal-scheduled langgraph runs          |
| Tokens              | `maxTokens`         | `200_000`  | running LLM-token sum across all iterations      |
| Recursion depth     | `maxRecursionDepth` | `1`        | depth of spawned sub-goals (0 = no recursion)    |
| No progress         | `maxStalledIterations` | `2`     | consecutive no-KPI-gain ticks → halt `no_progress` (invalidates) |

**No-progress halt** stops a stuck goal from grinding to the iteration/token cap
when the KPI isn't moving — the frontier "Progress" signal (AgentPRM). `LoopState`
tracks `stalledIterations`; the pure predicate returns `no_progress` before the raw
budget axes so a dead-end goal closes early instead of burning its full allotment.

**Recursive allotment** = `maxRecursionDepth`. A loop step MAY decide the goal
needs a sub-goal (a child hypothesis whose outcome becomes `evidence_for` the
parent). Depth is bounded so a goal can spawn at most a shallow tree, never an
unbounded fan-out. Depth lives in the EDO chain itself (`EDO_RECURSION_VIA_CITATIONS`)
— `LoopState.recursionDepth` is just the accounting that stops the descent.

The halt predicate is **pure** (`loopHaltReason(state, now)`), so it is unit-testable
without Temporal and the same predicate gates both the workflow and any future
manual driver. Goal-met wins over budget (a hit goal closes as validated even on the
last token); the `evaluate_at` wall-clock stop wins over the budget axes. These
defaults are deliberately tiny — MVP-stage, 1 dev, 0 users — so a misconfigured goal
burns cents. They piggyback on the resolver's existing `RESOLVER_MAX_BATCH_PER_TICK`
(N=10) cost ceiling; no new autoscaling, no new infra.

---

## How it stacks on citations + computed confidence

```
goal (hypothesis, metric:<kpi-id>, target=80)
  ◀── evidence_for ── finding #1   (loop iteration 1: a cited atom)
  ◀── evidence_for ── finding #2   (iteration 2)
  ◀── evidence_for ── finding #3   (iteration 3 → KPI now ≥ 80)
  ◀── validates    ── outcome      (loop halts goal_met; recompute fires)
```

Every supporting edge bumps confidence (`+10` capped at `+50`); the `validates`
outcome closes the loop and promotes the hypothesis toward `established`/`canonical`.
A goal that exhausts budget without hitting target files an `invalidates` outcome —
the prediction _"a bounded loop can hit this KPI"_ failed, the row's confidence is
penalised, and the next agent reading the chain sees a budget-too-small or
goal-too-hard signal instead of silent rot. **Syntropy by construction: the loop
can't run without leaving cited evidence, and confidence is never assigned, only
computed from that evidence.**

---

## Human surface: a goal is a type of agent

A goal-loop **is** an agent type — a scheduled, self-terminating research agent —
but it needs **no bespoke UI**. A goal is a `hypothesis` row with an evidence chain,
so it already renders in the existing `/knowledge?mode=chains` view (`ChainPanel.tsx`):
goal = chain root, the `evidence_for` atoms = the chain, `confidence_pct` = a progress
proxy, the `outcome` = the verdict.

What's actually missing is **navigation** — nothing leads a human there. The
`schedules` surface is an **API** (`/api/v1/schedules`), not a page; "use it for now"
means humans curl it, invisible.

**v0 human UI = a thin "Goals" lens, NOT a new schedules page:**

- list `hypothesis` rows with `resolution_strategy LIKE 'metric:%'`
- per row: KPI vs target, budget burn (iterations / tokens), last run, enabled
- each row links to its `/knowledge` chain (progress + verdict already render there)

Don't stand up a parallel schedules UI page — that splits one concept across three
surfaces (schedules API + knowledge chains + EDO). The single human concept is
**a goal = schedule (cadence + budget) ⨝ knowledge chain (progress + verdict)**: the
schedules API drives the loop, the knowledge chain shows it, the Goals lens joins
them. Deferred to `/implement` alongside the controller.

---

## What this PR ships vs defers

**Ships (this PR — design + minimal seam):**

- This design doc.
- `packages/knowledge-store/src/domain/goal-loop.ts` — `Goal`, `LoopBudget`
  (incl. `maxStalledIterations`), `LoopState` (incl. `stalledIterations`),
  `LoopHaltReason` (incl. `no_progress`), the pure `loopHaltReason` predicate,
  `haltEdge`, the `metric:<kpi-id>` convention (`MetricResolutionStrategySchema`,
  `kpiIdFromStrategy`), the `KPI_VERIFIER_INDEPENDENT` invariant, and
  `DEFAULT_LOOP_BUDGET`.
- Barrel exports from `@cogni/knowledge-store`.

**Deferred to a follow-up `/implement` (after review):**

- The **verifier-independent KPI reader port** (`kpiId → 0–100`) — an external
  metric or a separate librarian/judge, NOT `recomputeConfidence` of the row the
  loop writes. Own-`confidence_pct` is a smoke-test only (see § worker ≠ verifier).
- `GoalLoopWorkflow` Temporal workflow + schedule registration, threading
  `stalledIterations` so `no_progress` fires.
- The langgraph step node (one research/cite step per iteration).
- The `metric:` dispatch branch in the resolver cron
  (`pendingResolutions({ strategy: "metric:" })` → controller).
- Widening the `core__edo_hypothesize` Zod allow-list to accept `metric:<id>` as a
  resolution strategy at the tool boundary (validation-in-Zod per the spec).
- `tags` ↔ `Goal` encode/decode helper + its tests.
- The **"Goals" lens** UI (filter `metric:` hypotheses, KPI/budget header, link to
  chain) — NOT a schedules page (see § Human surface).

**Anti-sprawl note (per `knowledge-syntropy-expert`):** this is a Crawl-tier seam
on `proj.knowledge-syntropy`, adjacent to the L0 Curator tier. It introduces no new
table, no new entry_type, no parallel orchestration tool. If the follow-up implement
grows scope, file the next-tier work item and stop — don't bundle.
