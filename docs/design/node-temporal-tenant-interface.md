---
id: design.node-temporal-tenant-interface
type: design
title: Node↔Temporal Tenant Interface
status: draft
trust: draft
summary: "How a node declares recurring work and the operator runs it under that node's tenant identity — generalizing the existing graph-schedule path (schedule CRUD + ExecutionGrant + Temporal Schedule) to non-graph HTTP-dispatch, with one new generic workflow and a declarative repo-spec contract. story.5008."
read_when: Designing or reviewing node recurring-work, the generic NodeTaskWorkflow, the declarative node-schedule contract, or the tenant-principal execution binding.
owner: derekg1729
created: 2026-06-17
tags: [temporal, node-baas, ai-graphs]
---

# Node↔Temporal Tenant Interface

> **The held vision:** a node declares a recurring job in its own repo-spec; the
> operator runs it on schedule, under _that node's_ identity and grant — with the
> node writing **zero** Temporal code and the operator adding **zero** per-node code.

## The honest finding: this is ~80% assembly, not new infrastructure

A trace of the live seam (verified, not assumed — see Ground Truth) shows the
recurring-work platform already exists for graphs and is more general than it looks:

| Primitive                                                                           | Already exists      | File                                                                |
| ----------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------- |
| Schedule CRUD → DB row + Temporal Schedule                                          | ✅                  | `app/api/v1/schedules/route.ts`, `schedule-control.adapter.ts`      |
| **Per-node, RLS-scoped `ExecutionGrant`** (`graph:execute:{graphId}`)               | ✅                  | `drizzle-schedule.adapter.ts:120`                                   |
| Non-graph `workflowType` + `taskQueueOverride` as schedule params                   | ✅ (ledger uses it) | `schedule-control.adapter.ts:131,149`                               |
| Per-node task queue (`scheduler-tasks-<uuid>`), one per node UUID                   | ✅                  | `services/scheduler-worker/src/worker.ts:47`                        |
| **Declarative schedules in repo-spec** (`governance.schedules`) + reconcile service | ✅                  | `packages/repo-spec/src/schema.ts:46`, `syncGovernanceSchedules.ts` |
| HTTP-dispatch-to-node-route activity (graph variant)                                | ✅                  | `scheduler-worker/src/activities/index.ts:340`                      |

So the question "is Temporal hard to wire for a new node?" answers itself: **for a
graph, it already works** (proven live — red's graph executed end-to-end). The gap
is narrow and specific.

## The three gaps (and the minimal closes)

### Gap 1 — no generic non-graph workflow in the worker bundle

A new workflow _type_ must be compiled into the worker bundle
(`packages/temporal-workflows/src/scheduler.ts`); a node fork cannot register one.
`CollectEpochWorkflow` is the only non-graph workflow and is ledger-specific (it
orchestrates internal activities, does **not** call a node route).

**Close:** add **one** generic `NodeTaskWorkflow` to the bundle (operator, once).
It is the non-graph sibling of `GraphRunWorkflow`, following the canonical
`Webhook→Parent→…→Write Activity` pattern from `temporal-patterns.md`:

```
NodeTaskWorkflow(input: NodeTaskInput)              // .strict() zod, packages/scheduler-core
  → validateGrantActivity(grant, node)              // reuse — grant scope "task:dispatch:<route>"
  → dispatchNodeTaskActivity(node, route, payload)  // idempotent POST {nodeUrl}{route}
        idempotency-key = `${node}/${scheduleId}/${TemporalScheduledStartTime}`  // ACTIVITY_IDEMPOTENCY, no attempt
  → (no graph child — the node's route IS the work)
```

`dispatchNodeTaskActivity` is a near-clone of the existing `executeGraphActivity`
HTTP-dispatch (same `nodeUrl` resolution from `COGNI_NODE_ENDPOINTS`, same Bearer
pattern), pointed at a node-declared route instead of `/api/internal/graphs/.../runs`.
This single addition unlocks recurring non-graph work for **all** nodes and lets
governance-sync retire its external cron.

### Gap 2 — no node-facing declarative schedule field

`repo-spec` only exposes `governance.schedules` (operator charters), not a
node-author-facing contract.

**Close:** generalize it to a node-facing `schedules` block (T3), the left edge a
node owns (CATALOG_IS_SSOT / node-baas "node declares shape, operator wires env"):

```yaml
# .cogni/repo-spec.yaml
schedules:
  - id: metrics-ingest # stable → workflowId + scheduleId
    cron: "*/15 * * * *"
    timezone: UTC
    target: http-dispatch # | graph
    route: /api/internal/ops/growth/metrics-ingest # required when http-dispatch; node's own token-gated route
    payload: { window: "15m" } # opaque to operator; the node's route owns its meaning
    overlap: skip # OVERLAP_SKIP_DEFAULT
    catchupWindow: 0s # CATCHUP_WINDOW_ZERO
```

A `syncNodeSchedules` service (mirror of `syncGovernanceSchedules`) reconciles these
into Temporal Schedules at node provision/flight — create/update/pause, advisory-locked,
each backed by its `ExecutionGrant`. `target: graph` routes to the existing
`GraphRunWorkflow`; `target: http-dispatch` routes to `NodeTaskWorkflow` via the
existing `workflowType` param. **CRUD_AUTHORITY** stays with the sync service, never
the worker.

### Gap 3 — execution runs under a SHARED principal (the 0.1% hardening + the seam)

Today the dispatch activity authenticates as `SYSTEM_ACTOR` with a **shared
`SCHEDULER_API_TOKEN`**. The `ExecutionGrant` already scopes _what_ a schedule may do
per-node (RLS-backed, revocable) — but the wire identity is shared, so there is no
per-node attribution or blast-radius isolation at the token layer (this is the same
root as the shared-LLM-account 429: shared credentials, no tenant binding).

**Close (the seam — declare here, fill in the secrets work):**

- This design **requires** that `dispatchNodeTaskActivity` carry a **per-node service
  identity** (the node's own internal token / principal), not the shared
  `SCHEDULER_API_TOKEN`, and that the `ExecutionGrant` be scoped `task:dispatch:<route>`
  and validated per-node exactly as graph grants are today.
- The **provisioning** of that per-node credential is **out of scope here** — it is the
  shared-secrets-on-spawn work (separate dev). This design declares the slot
  (`activity resolves a per-node token`); that work fills it. Neither ships half: a
  `NodeTaskWorkflow` that still uses the shared token is not done.

This makes the grant model uniform: **principal → ExecutionGrant (per-node, RLS,
revocable) → scoped action**, identical for graph and http-dispatch. Killing a node
revokes its grants + credential atomically.

## Isolation boundary — decided

Shared `cogni-<env>` Temporal namespace + **per-node task queue** (`scheduler-tasks-<uuid>`,
already the model) + per-node `ExecutionGrant` + per-node dispatch principal. This is
today's shape plus the principal binding — no namespace-per-node (heavier ops, no MVP
need). Namespace-per-node is a documented future upgrade if cross-node noisy-neighbor
or quota isolation at the Temporal layer is ever required.

## What this is NOT

- Not a new workflow per node (one generic `NodeTaskWorkflow`, forever).
- Not a new deploy/promote workflow or deploy-infra branch (devops freeze respected —
  all additions are typed `.ts` in `packages/temporal-workflows` / `scheduler-core` /
  `services/scheduler-worker` + a repo-spec field).
- Not per-node namespaces.
- Not the per-node credential _provisioning_ (that's the secrets-on-spawn work; this
  only declares the principal seam it must fill).

## Task decomposition (story.5008)

- **T1 (`task.5029`)** — `NodeTaskWorkflow` + `dispatchNodeTaskActivity` + grant scope
  `task:dispatch:<route>`; add to the worker bundle. Owns `packages/temporal-workflows`,
  `services/scheduler-worker`, `packages/scheduler-core` schema. Consumes the principal seam.
- **T3 (`task.5030`)** — node-facing `schedules` repo-spec contract + `syncNodeSchedules`
  - node-template prototype + `temporal-patterns.md` node-as-tenant section + this seam in
    `node-baas-architecture.md`. Declares the schedule payload shape T1 consumes.
- **Seam between them:** the `NodeTaskInput` schema (T3 declares the node-authored shape;
  T1 consumes it) + the per-node dispatch principal (declared here, filled by secrets work).
- **Out of scope:** beacon status-gating/bridge (independent), per-node credential provisioning (secrets dev).

## Ground Truth (verified symbols)

`app/api/v1/schedules/route.ts:107` · `schedule-control.adapter.ts:51,123,131,149` ·
`drizzle-schedule.adapter.ts:109,120` · `scheduler-core/ports/schedule-manager.port.ts:119` ·
`temporal-workflows/workflows/graph-run.workflow.ts:67` ·
`temporal-workflows/workflows/collect-epoch.workflow.ts:57,93` ·
`scheduler-worker/src/worker.ts:47,152` · `scheduler-worker/src/activities/index.ts:192,340` ·
`repo-spec/src/schema.ts:46` · `scheduler-core/services/syncGovernanceSchedules.ts:181` ·
`api/internal/ops/governance/schedules/sync/route.ts:51`.
