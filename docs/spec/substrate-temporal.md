---
id: spec.substrate-temporal
type: spec
title: Temporal Substrate — one shared generic worker; nodes schedule their own routes & graphs
status: draft
trust: draft
summary: "Temporal is a Cogni substrate. ONE shared, operator-run worker executes only GENERIC workflows (GraphRunWorkflow, NodeTaskWorkflow, the operator's own epoch/governance) and dispatches the work INTO the node — this is how AI graphs and epochs already run, proven live. A node consumes the substrate by creating schedules that point at its OWN routes or graphs: no per-workflow Temporal code, no per-node worker. That is the extensible building block — a node ships 300 routes/graphs and can schedule any of them. The only sovereignty delta worth building: node-direct schedule CREATE (the node's own Temporal client + ESO creds) so /schedules registers under the node, not the operator. A per-node worker is an opt-in escape hatch for custom durable workflows only."
read_when: "Designing how a node runs recurring/triggered/durable work; making /schedules an extensible node building block; scoping task.5035; before proposing a per-node worker as default, a pg-boss second scheduler, or an operator-in-the-loop create API."
owner: derekg1729
created: 2026-06-18
verified: 2026-06-18
tags: [temporal, node-baas, substrate, scheduling, sovereignty]
---

# Temporal Substrate

## The model in one line

ONE shared, operator-run worker executes only **generic** workflows and dispatches the work
**into the node**; a node consumes the substrate by **scheduling its own routes and graphs**
through those generic workflows. No per-workflow Temporal code. No per-node worker. This is
**already how AI graphs and epochs run** — it is proven, not proposed.

## The extensible building block (this is the point)

`/schedules` is the node's recurring-work console. A node schedules **any route or any graph
it owns**, via two generic workflows — and writes **zero** Temporal code to do it:

| A node wants to…                         | It schedules…                           | The work runs…              |
| ---------------------------------------- | --------------------------------------- | --------------------------- |
| run one of its HTTP ops routes on a cron | `NodeTaskWorkflow` → the node's `route` | in the node's route handler |
| run an AI graph on a cron / trigger      | `GraphRunWorkflow` → the node's `graph` | in the node's graph runtime |

So a node "builds 300 different things" by writing **300 routes or graphs** — its normal
product code — and scheduling any of them from `/schedules`. The Temporal workflow types are
**fixed and generic**; the variety lives in the node's routes/graphs. **A new node adds zero
worker code and triggers no redeploy.** That is what makes it a building block instead of a
per-feature integration.

## As-built today (the proof this is right)

- **AI graphs** run via `GraphRunWorkflow`: the shared `scheduler-worker` runs the workflow
  and `executeGraphActivity` dispatches it into the node's graph route. **Live, proven (red ran
  end-to-end).**
- **Epochs** run via `CollectEpochWorkflow` on the same shared worker.
- **`NodeTaskWorkflow`** (merged) is the non-graph sibling — fire a node's HTTP route on a
  schedule. Same shared worker, same per-node task queue, same dispatch-into-node shape.
- `/schedules` + `POST /api/v1/schedules` already create Temporal schedules.

The substrate exists and works. The variety knob (routes/graphs) is the node's own app code.

## How a node consumes it

1. **Create (the sovereignty delta — the real build).** The node's app holds its **own**
   Temporal client (ESO-provisioned namespace creds) and calls `schedule.create(action =
NodeTaskWorkflow | GraphRunWorkflow, route|graph = its own, taskQueue = its own queue)`.
   Today schedule-create runs through the operator's client; making it **node-direct** (node's
   client, node's creds) is the one change that takes the operator out of the create path.
2. **Execute (shared, generic — unchanged).** The shared worker polls the node's queue, runs
   the generic workflow, and dispatches into the node's route/graph. The **work runs in the
   node**; the shared worker is generic dispatch infrastructure (like the Temporal cluster
   itself, or the node's operator-hosted Postgres) — never node-specific code.

Net: operator out of the **create** path; the node's **work** runs in the node; the shared
worker is shared substrate plumbing, not the operator's business logic in your path.

## The dispatch hop (honest, and already how graphs work)

Because the shared worker holds no node code, it calls the node over HTTP — exactly as
`executeGraphActivity` already does for graphs. That hop carries a per-node dispatch identity
(today the shared `SCHEDULER_API_TOKEN`, as graph dispatch uses; **per-node tokens are the
hardening, deferred**) and uses `maximumAttempts: 1` (at-most-once → no dedup store for MVP).
This is not new tax — it is the existing graph-dispatch mechanism, reused.

## Roadmap — durable multi-step and HITL

The current substrate runs a single route or a single graph per schedule tick. A graph can
contain an in-run AI pipeline, but that is not the durable multi-step answer for
`run graph → wait for human → run graph → branch` or other cross-run orchestration. The
roadmap shape is one generic durable step-list workflow on the shared worker: Temporal owns
signals, waits, timers, and replay; node-specific work still dispatches into the node's
routes and graphs.

## The escape hatch — a per-node worker (opt-in, RARE)

A node that needs **custom durable orchestration** — multi-step sagas, signals, long human
waits, work that cannot be expressed by the generic step-list engine — runs its **own**
Temporal worker with its **own** workflow defs, polling its own queue (the per-node queue is
the graduation seam). This is the only case that costs a worker pod, and it is **opt-in,
never the node-template default.** Generic recurring/triggered work never needs it.

## What this is NOT (the wrong turns this spec closes)

- ❌ **per-node worker as the default** — graphs prove the shared worker suffices; a pod per
  node for "fire my route on a cron" is the over-engineering.
- ❌ **a second scheduler (pg-boss/cron)** — Temporal already runs the node's graphs + epochs;
  a parallel scheduler is redundant.
- ❌ **an operator-in-the-loop create API** — create is node-direct (node's own client).

## What this means for task.5035

Re-scoped to its true shape: **give the node app its own Temporal client + ESO-provisioned
per-node namespace creds, and make `/schedules` create node-direct** against the existing
generic workflows. **Not** a per-node worker; **not** pg-boss; **not** an operator schedule
API. The shared worker + `NodeTaskWorkflow`/`GraphRunWorkflow` + per-node queues already exist.

## References

- [temporal-patterns.md](./temporal-patterns.md) — determinism, `CRUD_AUTHORITY`, the
  generic workflows, schedule config, the LangGraph-vs-Temporal (AI) boundary.
- [node-baas-architecture.md](./node-baas-architecture.md) — operator provisions substrate,
  node consumes directly (Postgres/Storage/Streams precedent).
- [node-temporal-tenant-interface.md](../design/node-temporal-tenant-interface.md) — the
  superseded operator-dispatch-as-default design.
