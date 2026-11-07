# goals · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Operator-owned Goals + KPIs presentation (story.0021). The measurement engine and the wire contract (`GoalsProgressSchema`, `KpiAssessmentSchema`, `MetricHistorySchema`, `MetricDisplaySchema`) live in the published `@cogni-dao/metrics` 0.3.0 package; this feature owns the Goals view (`components/GoalsBoard`), the open KPI chart (`components/KpiChart`) and per-type card numbers (`lib/display`). Ported once from node-template `app/src/features/goals` at 74ae240; the operator owns it from here.

## Pointers

- [Goals view mount](<../../app/(app)/knowledge/view.tsx>)
- [Goal metrics facade](../../app/_facades/metrics/goal-metrics.server.ts)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["shared", "components"],
  "must_not_import": ["app", "adapters", "bootstrap", "core", "ports"]
}
```

## Public Surface

- **Exports:** `GoalsBoard`, `GOALS_POLL_MS`, `MetricEvidence`, `fetchGoalsProgress`, `GOALS_QUERY_KEY`, `attentionCount`, `goalNeedsAttention`
- **Routes (if any):** reads `GET /api/v1/metrics/goals` and `GET /api/v1/metrics/{id}/history`
- **Files considered API:** `index.ts`

## Responsibilities

- This directory **does**: Render goal rows, KPI cards and charts from the read model; poll while the Goals tab is open
- This directory **does not**: Compute, assess or store metrics; import bootstrap, app or adapter code

## Notes

- Read at a glance: a count strip (goals and KPIs counted once each; every status count is a count of KPIs), then one collapsible row per goal. Inside a row, one card per KPI: label, number, at most one short hint, a status pill and one mark.
- Display type comes from the read model (`kpi.metric.display`); the UI never guesses from units.
- Status comes from `assessKpi` only; the UI never re-derives it. Every status shows a symbol and a word (`STATUS_META`); color is redundant.
- Unknown is not zero: no reading is "—" (`aria-label="No reading"`), never 0.
- Quiet refresh: a failed poll keeps the data; only `STALE_AFTER_FAILURES` consecutive failures mark it "Stale"; a 401 says "Signed out".
- Recharts 2 renders only its own element types as direct chart children: pass arrays, never Fragments. Every chart takes a `useChartId` id (SSR-stable). No animation.
- `GoalsBoard` accepts `goalId` (first KPI open) for a goal entry page; knowledge mounts it only on `?mode=goals`.
