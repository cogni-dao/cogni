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

> **The held vision:** a node declares a recurring job in its own repo-spec; it runs
> on schedule under _that node's_ identity and grant — with the node writing **zero**
> Temporal code and the operator adding **zero** per-node code. The operator's **managed
> Temporal substrate runs it by default** (a hosted convenience); a sovereign node can
> swap in its **own Temporal + worker** behind the same contract — see _Sovereignty &
> Scale_. The operator is the recurring-work _trigger_, never the _executor_, and never
> in a user-request path.

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

> **Review correction (4-lens adversarial, 2026-06-17 — all `approve-with-changes`):**
> "~80% assembly" is defensible for **Gaps 1–2** (workflow bundle, repo-spec block,
> reconcile service are genuine assembly + freeze-clean). It is **NOT** true for **Gap 3**:
> grant↔node binding, scope-generalized grant validation, route allow-listing, and
> per-node principal resolution are **real new primitive work the build creates** — the
> 20%. Gap 3 below is reframed accordingly. The uniform `principal → ExecutionGrant →
scoped action` model is a _target this work builds_, not a property that exists today.

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
NodeTaskWorkflow(input: NodeTaskInput)              // .strict() zod, packages/temporal-workflows/src/workflows/node-task.schema.ts (T1 owns it — SINGLE_INPUT_CONTRACT)
  scheduledFor = workflowInfo().searchAttributes.TemporalScheduledStartTime  // SCHEDULED_TIME_FROM_TEMPORAL (mirror graph-run.workflow.ts:127), NOT input
  → validateGrantActivity(actor, nodeId, grantId, "task:dispatch:<route>")   // NET-NEW: must assert grant↔node (M1) + scope-generalized (M2)
  → dispatchNodeTaskActivity(nodeId, route, payload, scheduledFor)            // POST {nodeUrl}{route}, principal = per-node token (G1, fail-closed)
        Idempotency-Key: `${nodeId}/${scheduleId}/${scheduledFor}`           // header; the NODE ROUTE must dedup on it (hard contract)
        retry profile: maximumAttempts:1 (MVP — mirrors executeGraphActivity GRAPH_EXECUTION_ACTIVITY_OPTIONS; no retry until the dedup contract is proven)
  → (no graph child — the node's route IS the work)
```

`dispatchNodeTaskActivity` mirrors the existing `executeGraphActivity` HTTP-dispatch
(`nodeUrl` resolution from `COGNI_NODE_ENDPOINTS`, Bearer pattern), pointed at a
node-declared route instead of `/api/internal/graphs/.../runs`. **Non-obvious
requirements the build MUST honor (review M-fixes):**

- **Idempotency is a two-sided contract (M3).** The operator forwards
  `Idempotency-Key: ${nodeId}/${scheduleId}/${scheduledFor}`; the node route **MUST**
  dedup on it. A key the receiver ignores does not make a POST idempotent. MVP retry
  profile = `maximumAttempts:1` (the cited graph clone uses exactly this, precisely for
  idempotency-collision risk); a retry profile is gated on the documented dedup contract.
- **`scheduledFor` derives from the `TemporalScheduledStartTime` search attribute**
  inside the workflow (M-fix), never from input or wall clock (SCHEDULED_TIME_FROM_TEMPORAL).
- **Route allow-listing (M3/security):** `route` is validated to the node's OWN host —
  relative path on the node's resolved `nodeUrl` only; never an absolute/foreign URL (SSRF / cross-tenant).
- **Grant validation here is NET-NEW (G2):** the only current non-graph workflow
  (CollectEpoch) never calls `validateGrantActivity` — wiring it into `NodeTaskWorkflow`
  is new work + tests, not reuse.

This single addition unlocks recurring non-graph work for **all** nodes and becomes the
generic "non-graph workflow" (superseding CollectEpoch's special status). _(It does not
"retire a cron" — governance-sync is already an in-app Temporal job, not external cron.)_

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

**This is the new-infra 20% — four real primitive changes, not assembly:**

1. **Grant↔node binding (M1, security-blocker).** Today `validateGrantForGraph` loads the
   grant by `grantId` alone and only checks the scope string — the grant row is bound to
   `userId/billingAccountId`, **not `nodeId`**. So "per-node blast-radius isolation" does
   **not** exist on the dispatch path (RLS scopes who may CREATE a grant, not which node a
   worker dispatches with it). The build MUST add a `grant↔node` assertion in validation.
2. **Scope-generalized grant (M2).** Grant scope is hardcoded `graph:execute:${graphId}`
   with a graph-specific `validateGrantForGraph`. `task:dispatch:<route>` requires a
   generalized `validateGrantForScope(actor, nodeId, grantId, scope)` (+ a non-hardcoded
   mint). Graph validation becomes `scope=graph:execute:<id>` — the uniformity is a target
   the build creates.
3. **Per-node dispatch principal, FAIL-CLOSED (G1, the seam to the secrets work).** Replace
   the shared `SCHEDULER_API_TOKEN` with a `NodePrincipalResolver.resolve(nodeId) → {token} |
throws`. T1 ships a stub that **throws when unprovisioned** — a shared-token
   `NodeTaskWorkflow` is **not done** (CI/review gate, not prose). The credential
   _provisioning_ is the shared-secrets-on-spawn work (separate dev); this declares the slot
   it must fill — hard sequencing dependency.
4. **Teardown contract (M7).** The reconcile mirror (syncGovernanceSchedules) pauses a removed
   schedule but does **not** revoke its grant — so "killing a node revokes atomically" is
   false today. Decommission MUST: (a) pause/delete the node's Temporal schedules, (b)
   `revokedAt` all grants scoped to that node, (c) revoke the per-node credential; validation
   fails closed on revoked grants (`GrantRevokedError`, already supported). One saga, with an
   ordering/idempotency note.

## Isolation boundary — decided

Shared `cogni-<env>` Temporal namespace + **per-node task queue** (`scheduler-tasks-<uuid>`,
already the model) + per-node `ExecutionGrant` + per-node dispatch principal. This is
today's shape plus the principal binding — no namespace-per-node (heavier ops, no MVP
need). Namespace-per-node is a documented future upgrade if cross-node noisy-neighbor
or quota isolation at the Temporal layer is ever required.

## Sovereignty & Scale — the managed scheduler is a convenience, not a lock-in

> **Reframe (the "operator runs it" correction, 2026-06-17).** The operator is the
> recurring-work **trigger**, never the **executor**. At each tick
> `dispatchNodeTaskActivity` does `POST {nodeUrl}{route}` under the node's own grant +
> principal — the work runs in the node's route, in the node's DB. **The operator is in
> zero user-request paths**; a node's users hit the node directly. The operator is only
> the cron that fires scheduled triggers, under tenant identity.

"Operator runs it" is the **hosted-node** model, and it is a managed convenience — not a
sovereignty cost — because the seam is **portable**. The same node-owned contract drives
two swappable reconcile backends:

| Model                       | Reconcile backend (cron + worker)                                               | Owner                                                             |
| --------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Hosted** (submodule node) | operator's managed Temporal + `scheduler-worker` (`syncNodeSchedules`)          | operator — consistent; it already owns the hosted node's plane    |
| **Standalone-sovereign**    | the node's **own Temporal + worker**, reconciling the SAME `schedules` contract | the node — `standalone-node` sovereignty is explicitly not frozen |

**`TEMPORAL_IS_SWAPPABLE_SUBSTRATE`.** The node-facing surface is two portable things: the
declarative `schedules` repo-spec block (node-owned shape) and the `ExecutionGrant` +
`validateGrantForScope` / `NodePrincipalResolver` ports. **Those ports are an _auth
abstraction over a Temporal substrate the operator manages_ — a convenience, not a
binding.** A node that wants its own scheduler swaps the Temporal + worker behind the same
contract + port shape; nothing in its repo-spec or its route changes. Operator-managed is
the easy default; self-hosting is a backend swap, not a rewrite.

**Scale + reliability — don't bake centrality.** The managed substrate scales on standard
Temporal patterns, and the sovereign escape hatch caps the central blast radius:

- per-node task queue (`scheduler-tasks-<uuid>`, built) isolates execution today;
- `scheduler-worker` is a **horizontal pool**, not a singleton;
- namespace-per-node is the documented next isolation rung (_Isolation boundary_, above);
- node-local reconcile (the standalone row) offloads a node's entire schedule volume off
  the operator when it chooses — so "operator Temporal down → no scheduled fires" is bounded
  to _hosted_ nodes, and any node can opt out of that dependency entirely.

**The invariant this protects (`SCHEDULER_BACKEND_IS_NOT_THE_CONTRACT`):** the
operator-managed scheduler must never become the _only_ way a node runs recurring work.
T1/T3 build the hosted path so the contract + ports stay backend-agnostic; `syncNodeSchedules`
and the worker must never assume a single shared Temporal is the model.

## Syntropy: graph and non-graph recurring work are ONE spine, not two

The design intent is **shared primitives, not a parallel stack** — AI graph execution
and node recurring-work run on the _same_ spine, diverging only at the leaf:

| Primitive                                                                                        | Shared by graph + non-graph                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schedule CRUD (`POST /schedules` → DB row + Temporal Schedule)                                   | one path                                                                                                                                                                                            |
| `ExecutionGrant` + `validateGrantForScope(actor, nodeId, grantId, scope)`                        | one validator — graph uses `graph:execute:<id>`, task uses `task:dispatch:<route>`. **The graph path migrates onto the generalized validator** (do NOT leave `validateGrantForGraph` as a parallel) |
| Per-node task queue (`scheduler-tasks-<uuid>`) + namespace                                       | one model                                                                                                                                                                                           |
| `NodePrincipalResolver` (per-node identity)                                                      | one resolver — lifts BOTH graph dispatch and task dispatch off the shared `SCHEDULER_API_TOKEN`                                                                                                     |
| Schedule action = discriminated union `{kind:'graph', graphId} \| {kind:'http-dispatch', route}` | one contract; node declares `graph` xor `route`; workflow selection branches on `kind`                                                                                                              |

The **only** legitimate divergence is the leaf workflow, and it follows
`temporal-patterns.md`'s LangGraph-vs-Temporal boundary: `GraphRunWorkflow` runs the
LLM graph-executor path (reasoning loop + `graph_runs`); `NodeTaskWorkflow` is a plain
durable write (no graph child). They **share the node-dispatch helper** (nodeUrl
resolution + principal + `Idempotency-Key`) rather than cloning it.

**Anti-pattern this design forbids (split-brain):** `dispatchNodeTaskActivity` as a fork
of `executeGraphActivity`, a second grant validator, a second principal path. Generalize
the existing graph primitives so the non-graph path _reuses_ them — that is the syntropy.

## What this is NOT

- Not a new workflow per node (one generic `NodeTaskWorkflow`, forever).
- Not a new deploy/promote workflow or deploy-infra branch (devops freeze respected —
  all additions are typed `.ts` in `packages/temporal-workflows` / `scheduler-core` /
  `services/scheduler-worker` + a repo-spec field).
- Not per-node namespaces.
- Not the per-node credential _provisioning_ (that's the secrets-on-spawn work; this
  only declares the principal seam it must fill).

## Storage decision (M-fix — no migration for MVP)

`schedules.graph_id` is `NOT NULL` and the arg-builder emits a fixed `GraphRunWorkflowInput`
for every `workflowType` (CollectEpoch survives by ignoring graph fields and reading
`raw.input`). MVP follows that ledger pattern: tunnel `{route, payload}` inside `input` as
the `NodeTaskInput` envelope, set `graph_id = "task:<route>"` to satisfy the constraint —
**zero migration**. Promoting `route` to a typed column (nullable `graph_id` +
`workflow_type`/`target`) is a documented follow-up, not MVP.

## Task decomposition (story.5008)

- **T1 (`task.5029`)** — `NodeTaskWorkflow` + `dispatchNodeTaskActivity` + **the new-infra
  primitives**: grant↔node binding (M1), `validateGrantForScope` (M2), `NodePrincipalResolver`
  fail-closed stub (G1), route allow-listing (M3). Owns `packages/temporal-workflows` (incl.
  `node-task.schema.ts` — SINGLE_INPUT_CONTRACT), `services/scheduler-worker`, the grant-port
  generalization. Grant validation on a non-graph workflow is **net-new** (G2), not reuse.
- **T3 (`task.5030`)** — node-facing `schedules` repo-spec contract + `syncNodeSchedules` +
  node-template prototype + docs. **Schema hygiene (G3):** infer `workflowType` from `route`
  xor `graph` (drop the `target` enum — operator vocab); `overlap`/`catchupWindow` are platform
  invariants → clamp/reject or drop; real cron-drift handling (`scheduleConfigChanged` skips
  cron today — latent bug); `syncNodeSchedules` is `SYSTEM_OPS_ONLY` (CRUD_AUTHORITY, never
  node-callable); **operator-pin `nodeId` to the repo-spec's registry `node_id`, reject
  foreign-node schedules (M8)**; `workflowId = node-task:{node}:{scheduleId}`.
- **Seam between them:** `NodeTaskInput` (T1 owns the schema; T3's repo-spec contract produces
  it) + the per-node dispatch principal (T1 declares the fail-closed resolver; the
  secrets-on-spawn work fills it).
- **Out of scope:** beacon status-gating/bridge (independent); per-node credential
  _provisioning_ (secrets dev — T1 only declares the fail-closed seam).

## Ground Truth (verified symbols)

`app/api/v1/schedules/route.ts:107` · `schedule-control.adapter.ts:51,123,131,149` ·
`drizzle-schedule.adapter.ts:109,120` · `scheduler-core/ports/schedule-manager.port.ts:119` ·
`temporal-workflows/workflows/graph-run.workflow.ts:67` ·
`temporal-workflows/workflows/collect-epoch.workflow.ts:57,93` ·
`scheduler-worker/src/worker.ts:47,152` · `scheduler-worker/src/activities/index.ts:192,340` ·
`repo-spec/src/schema.ts:46` · `scheduler-core/services/syncGovernanceSchedules.ts:181` ·
`api/internal/ops/governance/schedules/sync/route.ts:51`.
