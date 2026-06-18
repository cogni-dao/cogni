---
id: proj.node-automations-ui
type: project
primary_charter:
title: Node Automations — first-class Schedules & Runs UI
state: Active
priority: 2
estimate: 5
summary: "Promote node-template's hidden /schedules into a first-class Automations experience: see + manage + observe scheduled work of mixed kinds (cron→route jobs AND AI graph runs), with Runs as the primary object. Exercises the existing Temporal substrate; the visual workflow editor is explicitly out of scope."
outcome: "Success is when a node dev/operator can open an Automations tab, see every schedule (route or graph) and its run history, drill into a run's step timeline, and pause/resume/delete — proving the Temporal substrate is actually used, not just paper."
assignees: derekg1729
created: 2026-06-18
updated: 2026-06-18
labels: [temporal, node-template, ui]
---

# Node Automations — first-class Schedules & Runs UI

## Goal

The Temporal substrate is live (`GraphRunWorkflow`, `NodeTaskWorkflow`, per-node queues,
`POST /api/v1/schedules`) but the only surface is a hidden `/schedules` tab framed as AI
graphs. This project makes scheduled work a **first-class node experience** — a node ships
routes and graphs and manages them from one **Automations** tab — so the substrate is
genuinely exercised. The framing is **"your scheduled work,"** not "AI": a schedule fires a
**route** (plain cron) OR a **graph** (AI), shown uniformly and typed. Per
[temporal-patterns.md](../../docs/spec/temporal-patterns.md) `WORKFLOW_TOP_LEVEL_VISIBILITY`,
**Runs are the primary object**; a graph run's AI steps are drill-down detail.

This is the **node-template product lane**. It is related to, but distinct from,
[`proj.workflow-building-monitoring`](./proj.workflow-building-monitoring.md), which is the
operator/admin workflow visibility lane for system workflows.

## Roadmap

### Crawl (P0) — surface what already runs

**Goal:** A first-class, navigable Automations tab over the existing substrate. Read-mostly.

| Deliverable                                                                                                 | Status      | Est | Work Item |
| ----------------------------------------------------------------------------------------------------------- | ----------- | --- | --------- |
| Promote `/schedules` out of hidden nav → first-class **Automations** section (renamed from AI-only framing) | Not Started | 1   | —         |
| **Schedules** view: list all schedules with **kind** (route \| graph), cron, next-run, on/off               | Not Started | 2   | —         |
| **Runs** view: execution history (status, started, duration), backed by Temporal + `graph_runs`             | Not Started | 2   | —         |
| Pause / resume / delete a schedule (reuse existing `CRUD_AUTHORITY` endpoints — no new authority)           | Not Started | 1   | —         |

### Walk (P1) — observe a single run

**Goal:** Drill into one run; the run-detail timeline is the differentiator.

| Deliverable                                                                                            | Status      | Est | Work Item            |
| ------------------------------------------------------------------------------------------------------ | ----------- | --- | -------------------- |
| Run-detail page: step/timeline view — graph run shows AI steps, route job shows result/log + Loki link | Not Started | 3   | (create at P1 start) |
| Create-schedule form supports both kinds uniformly (pick route or graph + cron)                        | Not Started | 2   | (create at P1 start) |

### Run (P2+) — author multi-step (gated)

**Goal:** Compose multi-step / human-in-the-loop work. **Blocked on the composition engine.**

| Deliverable                                         | Status      | Est | Work Item                 |
| --------------------------------------------------- | ----------- | --- | ------------------------- |
| Visual workflow editor (n8n-style step composition) | Not Started | 5   | (gated — see Constraints) |
| Retry / replay-from-step controls                   | Not Started | 2   | (create at P2 start)      |

## Constraints

- **Exercise, don't extend.** P0/P1 build on the _existing_ substrate (`GraphRunWorkflow`,
  `NodeTaskWorkflow`, `/api/v1/schedules`); no new workflow types, no per-node worker.
- **Mixed kinds, not AI-only.** Route jobs and graph runs are both first-class scheduled
  work, shown uniformly and typed. Do not frame the tab as "AI schedules."
- **Runs is the hero view**, not the schedule list (per the visibility invariant in the spec).
- **The visual editor (P2) is gated** on the multi-step composition engine, which is NOT
  built. Do not start P2 until that engine ships; v0/P1 must not pretend one graph is the
  multi-step answer.
- **Read-mostly first.** P0 surfaces existing state; mutations reuse existing CRUD authority.

## Dependencies

- [x] Temporal substrate live (`GraphRunWorkflow` / `NodeTaskWorkflow` / per-node queues) — merged
- [x] `defineScheduledJob` route DX (PR #1759) — merged
- [ ] Run history is queryable per node (Temporal list + `graph_runs`) — confirm read path
- [ ] (P2 only) generic multi-step / HITL composition engine — not built; product decision pending

## As-Built Specs

- [substrate-temporal.md](../../docs/spec/substrate-temporal.md) — the shared-worker substrate
- [temporal-patterns.md](../../docs/spec/temporal-patterns.md) — `WORKFLOW_TOP_LEVEL_VISIBILITY`, the generic workflows
- [node-temporal.md](../../docs/guides/node-temporal.md) — node-dev guide (build a graph/route, schedule it)

## Design Notes

- Exemplars: **Inngest / Trigger.dev / Temporal UI / n8n** — all converge on two first-class
  objects, **Definitions + Runs**, with a **run-detail timeline** (see each step; retry/replay
  from a step) as the killer feature. None frame the surface as "AI"; it's "your functions +
  their runs." Cogni's split maps cleanly: Definitions = Schedules (route|graph), Runs = Temporal
  workflow executions, step timeline = graph_runs / activity history.
- Why Runs over Schedules as the hero: a schedule is static config; the value (did it fire? did
  it work? what did it produce?) lives in the runs. Matches the spec invariant.
- Out of scope and why: the visual editor is the most-requested-looking feature but it's the
  _least_ ready — it presupposes durable multi-step composition we haven't built. Shipping the
  observe/manage surface first is the honest exercise of what exists.
