---
id: scheduler-spec
type: spec
title: Scheduled Graph Execution Design
status: active
trust: draft
summary: Temporal-based scheduling system for graph execution via internal HTTP API with durable ExecutionGrants and graph_runs persistence
read_when: Implementing scheduled workflows, execution grants, or Temporal integration
owner: derekg1729
created: 2026-02-05
verified: 2026-10-09
tags: [scheduler]
---

# Scheduled Graph Execution Design

> [!CRITICAL]
> Scheduled runs execute via **internal HTTP API** using durable **ExecutionGrants** (not user sessions). Worker calls `POST /api/internal/graphs/{graphId}/runs` with shared-secret auth—never imports graph execution code.

> [!IMPORTANT]
> This document describes the **as-built centralized compatibility lane**. The target is
> node-sovereign: each node ships a private `workflow-worker` and node-owned Workflow bundle in
> its own environment namespace, while preserving this same internal graph-run API as the one
> billed execution path. See [Temporal Substrate](./substrate-temporal.md).

---

## Core Invariants

> See [Temporal Patterns](temporal-patterns.md) for canonical Temporal patterns, anti-patterns, and code examples shared across scheduler and governance workflows.

### Governance Layer (Stable)

1. **SCHEDULES_NEVER_BYPASS_EXECUTOR**: All scheduled graph execution flows through `GraphExecutorPort.runGraph()`. Scheduling layer owns timing only—never direct LLM/provider calls.

2. **GRANT_NOT_SESSION**: Scheduled runs authenticate via durable `ExecutionGrant` (scoped, revocable, time-limited), never user sessions. Workers never hold `NextAuth` session state.

3. **BILLING_VIA_GRANT**: Every `ExecutionGrant` has a `billingAccountId`. Execution service derives `virtualKeyId` from billing account's default key. All existing billing/idempotency invariants (graph-execution.md) apply unchanged.

4. **GRANT_VALIDATED_TWICE**: Worker validates grant before calling API (fail-fast). Execution service re-validates grant validity + scope (defense-in-depth). Scope format: `graph:execute:{graphId}` or `graph:execute:*`.

5. **RUN_LEDGER_FOR_DB_SCHEDULES**: DB-backed schedules create `graph_runs` records with status progression (pending→running→success/error). Temporal-only schedules (e.g., governance `governance:*`) do not write `graph_runs`.

6. **EXECUTION_VIA_SERVICE_API**: Worker triggers runs via HTTP to `POST /api/internal/graphs/{graphId}/runs`. Worker NEVER imports graph execution code.

7. **INTERNAL_API_SHARED_SECRET**: Internal calls require Bearer token (shared secret). Follows `METRICS_TOKEN` pattern. Caller service name logged. P1: JWT with aud/exp.

8. **EXECUTION_IDEMPOTENCY_PERSISTED**: `execution_requests` table persists idempotency key → `{runId, traceId}`. This is the correctness layer for slot deduplication.

9a. **SCHEDULE_CREATION_REJECTS_IF_CURRENTLY_UNPAYABLE**: `POST /api/v1/schedules` performs a coarse credit gate before creating the schedule. Paid model + balance ≤ 0 → 402. Free models and requests without a model field bypass the check. This is a creation-time guard only; the `PreflightCreditCheckDecorator` enforces at execution time (per CREDITS_ENFORCED_AT_EXECUTION_PORT).

9. **RUN_OWNERSHIP_BOUNDARY**: Each node-app owns its own `graph_runs` rows in its own database. The worker is HTTP-only (per SHARED_COMPUTE_HOLDS_NO_DB_CREDS, task.0280): `createGraphRunActivity` / `updateGraphRunActivity` / `validateGrantActivity` all POST/PATCH against `{nodeUrl}/api/internal/graph-runs...` and `{nodeUrl}/api/internal/grants/:id/validate`, authenticated by `SCHEDULER_API_TOKEN`. Execution service owns graph execution + billing (`charge_receipts`). Correlation via `runId` and `langfuseTraceId`.

### Temporal-Specific Invariants

10. **AS_BUILT_NAMESPACE_PER_ENV + QUEUE_PER_NODE_ISOLATION**: The compatibility lane uses `cogni-{APP_ENV}` plus `${TEMPORAL_TASK_QUEUE}-${getNodeId()}` and a centralized Worker. The target uses `cogni-<env>-<nodeId>` plus stable `agent-workflows`, polled by that node's own Worker. Task Queues isolate routing/throughput; only Namespaces provide the required credential/visibility boundary.

11. **WORKER_NEVER_CONTROLS_SCHEDULES**: `scheduler-worker` must not depend on `ScheduleControlPort` or call Temporal schedule APIs. CRUD routes are the single authority. Enforce via dep-cruiser.

12. **WORKFLOW_ID_INCLUDES_TIMESTAMP**: Temporal workflowId = `{temporalScheduleId}:{TemporalScheduledStartTime}`. Each scheduled slot gets a unique workflow. `temporalScheduleId` remains the business key for correlation. Temporal overlap=SKIP ensures only one active workflow per schedule at a time.

13. **SLOT_IDEMPOTENCY_VIA_EXECUTION_REQUESTS**: Slot deduplication handled by `execution_requests` table with key = `temporalScheduleId:TemporalScheduledStartTime`. The internal API idempotency layer (request_hash check) is the correctness guarantee—not workflowId uniqueness.

13b. **ACTIVITY_IDEMPOTENCY**: All Activities must be idempotent or rely on downstream idempotency. `executeGraphActivity` relies on `execution_requests` table. `updateScheduleRunActivity` must use monotonic status updates (pending→running→success/error, never backwards).

14. **SCHEDULED_TIMESTAMP_FROM_TEMPORAL**: Activities derive `scheduledFor` from `TemporalScheduledStartTime` search attribute (authoritative source), never from workflow input or wall clock.

15. **CRUD_IS_TEMPORAL_AUTHORITY**: Schedule CRUD endpoints (create/update/enable/disable/delete) are the single authority for Temporal schedule lifecycle. Worker never modifies schedules.

16. **NO_WORKER_RECONCILIATION**: Worker executes workflows only. Drift repair is a separate admin command (`pnpm scheduler:reconcile`), not an always-on loop.

17. **DB_TIMING_IS_CACHE_ONLY**: `schedules.next_run_at` and `last_run_at` are cache columns for UI/quick-queries. Authoritative timing lives in Temporal. Synced on CRUD only; drift is acceptable.

18. **SKIP_MISSED_RUNS**: P0 does not backfill missed runs. Temporal `catchupWindow=0` enforces this.

19. **UPDATE_ON_DRIFT**: `syncGovernanceSchedules` describes each existing Temporal schedule and compares input payload (model, message) and timezone against desired config. If config has drifted, it calls `updateSchedule()` to patch the schedule in-place. Unchanged schedules are skipped. This prevents stale schedules from running with outdated parameters after config changes.

---

## Architecture

### Progression

| Phase           | Worker Entry                                           | Scheduler                          | Status     |
| --------------- | ------------------------------------------------------ | ---------------------------------- | ---------- |
| **1 (Legacy)**  | `src/scripts/run-scheduler-worker.ts`                  | Graphile Worker                    | ✅ Deleted |
| **2 (Current)** | `services/scheduler-worker/src/main.ts`                | Temporal Schedules                 | ✅ Merged  |
| **3 (Target)**  | node `services/workflow-worker` + `packages/workflows` | Node-owned durable agent workflows | 🔲 Planned |

### Package Extraction (Complete)

| Extracted From                       | Extracted To            |
| ------------------------------------ | ----------------------- |
| `src/types/scheduling.ts`            | `@cogni/scheduler-core` |
| `src/ports/scheduling/*`             | `@cogni/scheduler-core` |
| `src/adapters/server/scheduling/*`   | `@cogni/db-client`      |
| `src/shared/db/schema.scheduling.ts` | `@cogni/db-schema`      |

### Temporal Architecture (centralized compatibility lane)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CRUD Endpoints (Single Authority for Temporal Schedules)                    │
│ All Temporal calls go through ScheduleControlPort (vendor-agnostic)         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  POST /api/v1/schedules                                                     │
│    1. Create ExecutionGrant                                                 │
│    2. Insert into schedules table                                           │
│    3. scheduleControl.createSchedule({ scheduleId, cron, timezone, ... })   │
│       └─► Adapter: overlap=SKIP, catchupWindow=0 (hardcoded)                │
│    On Temporal failure: rollback DB, return 503                             │
│                                                                             │
│  PATCH /api/v1/schedules/:id (enabled toggle)                               │
│    1. Update DB                                                             │
│    2. scheduleControl.pauseSchedule() / resumeSchedule()                    │
│    On Temporal failure: rollback DB, return 503                             │
│                                                                             │
│  DELETE /api/v1/schedules/:id                                               │
│    1. scheduleControl.deleteSchedule()                                      │
│    2. Delete from DB (only if Temporal succeeds)                            │
│    On Temporal failure: return 503, do NOT delete DB                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Temporal Infrastructure                                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Temporal Cloud (or self-hosted)                                            │
│    • Namespace: cogni-{APP_ENV}                                             │
│    • TaskQueues (one per node): scheduler-tasks-<nodeUuid>                  │
│                    (+ legacy "scheduler-tasks" drain queue)                 │
│    • Schedules: overlap=SKIP, catchupWindow=0                               │
│                                                                             │
│  services/scheduler-worker/ (one pod, N+1 Temporal Workers)                 │
│    • One Worker per canonical nodeId (UUID) in COGNI_NODE_ENDPOINTS         │
│    • Plus one drain Worker on the legacy queue (task.0327 migration)        │
│    • Activities HTTP-delegate runs+grants to each node's /api/internal      │
│    • Does NOT create/update/delete schedules (CRUD is authority)            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Execution Flow                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Temporal Schedule fires → GovernanceScheduledRunWorkflow                   │
│    Activity: validateGrantActivity(grantId)         // fail-fast            │
│    Activity: createScheduleRunActivity(...)         // DB-backed only       │
│    Activity: executeGraphActivity({                                         │
│      temporalScheduleId,                                                    │
│      graphId,                                                               │
│      grantId,                                                               │
│      scheduledFor: TemporalScheduledStartTime,      // from Temporal        │
│      idempotencyKey: `${temporalScheduleId}:${scheduledFor}`                │
│    })                                                                       │
│      → POST /api/internal/graphs/{graphId}/runs                             │
│         ├─ Bearer: $INTERNAL_API_TOKEN                                      │
│         ├─ Idempotency-Key: {temporalScheduleId}:{scheduledFor}             │
│         └─ Body: { executionGrantId, input }                                │
│    Activity: updateScheduleRunActivity(success/error)                       │
│                                                                             │
│  [If HITL required]                                                         │
│    Workflow waits for Signal: 'plane_review_decision'                       │
│    Plane webhook → temporalClient.workflow.signal(...)                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Idempotency Layers

| Layer             | Key                                                 | Storage              | Prevents                    |
| ----------------- | --------------------------------------------------- | -------------------- | --------------------------- |
| Temporal Schedule | temporalScheduleId (string)                         | Temporal             | Duplicate schedule identity |
| Workflow          | workflowId = `{temporalScheduleId}:{scheduledFor}`  | Temporal             | Concurrent slot executions  |
| Execution API     | `{temporalScheduleId}:{TemporalScheduledStartTime}` | `execution_requests` | Duplicate runs on retry     |
| Billing           | `runId/attempt/unit`                                | `charge_receipts`    | Duplicate charges           |

> **Note:** DB-backed schedules use UUID IDs; governance schedules use Temporal-only IDs like `governance:govern`. Workflow input carries `temporalScheduleId` plus optional `dbScheduleId`.

---

## Schema

### `execution_grants`

| Column               | Type        | Constraints                   | Notes                              |
| -------------------- | ----------- | ----------------------------- | ---------------------------------- |
| `id`                 | uuid        | PK                            |                                    |
| `user_id`            | text        | NOT NULL, FK users            | Grant owner                        |
| `billing_account_id` | text        | NOT NULL, FK billing_accounts | Charge target                      |
| `scopes`             | text[]      | NOT NULL                      | `["graph:execute:langgraph:poet"]` |
| `expires_at`         | timestamptz | NULL                          | Optional expiration                |
| `revoked_at`         | timestamptz | NULL                          | Soft revocation                    |
| `created_at`         | timestamptz | NOT NULL                      |                                    |

**Indexes:** `idx_grants_user_id`, `idx_grants_billing_account_id`

### `schedules`

| Column                 | Type        | Constraints                   | Notes                                      |
| ---------------------- | ----------- | ----------------------------- | ------------------------------------------ |
| `id`                   | uuid        | PK                            | Also used as Temporal scheduleId           |
| `owner_user_id`        | text        | NOT NULL, FK users            |                                            |
| `execution_grant_id`   | uuid        | NOT NULL, FK execution_grants |                                            |
| `graph_id`             | text        | NOT NULL                      | e.g., `langgraph:poet`                     |
| `input`                | jsonb       | NOT NULL                      | Graph input payload                        |
| `cron`                 | text        | NOT NULL                      | 5-field cron                               |
| `timezone`             | text        | NOT NULL                      | IANA timezone                              |
| `enabled`              | boolean     | NOT NULL, default true        |                                            |
| `temporal_schedule_id` | text        | NULL                          | Set after Temporal schedule created        |
| `next_run_at`          | timestamptz | NULL                          | **CACHE ONLY** - synced on CRUD, may drift |
| `last_run_at`          | timestamptz | NULL                          | **CACHE ONLY** - updated on run completion |
| `created_at`           | timestamptz | NOT NULL                      |                                            |
| `updated_at`           | timestamptz | NOT NULL                      |                                            |

**Indexes:** `idx_schedules_owner`, `idx_schedules_grant`

> **Note:** `next_run_at` and `last_run_at` are cache columns for UI display. Authoritative timing is from `temporalClient.schedule.describe(scheduleId).info.nextActionTimes`.

### `graph_runs`

| Column              | Type        | Constraints                 | Notes                                                                 |
| ------------------- | ----------- | --------------------------- | --------------------------------------------------------------------- |
| `id`                | uuid        | PK                          |                                                                       |
| `schedule_id`       | uuid        | NULL, FK schedules          | Null for non-scheduled runs; set for DB-backed schedules              |
| `run_id`            | text        | NOT NULL                    | Canonical GraphExecutorPort `runId`                                   |
| `graph_id`          | text        | NULL                        | Namespaced graph ID                                                   |
| `run_kind`          | text        | NULL                        | `user_immediate` \| `system_scheduled` \| `system_webhook`            |
| `trigger_source`    | text        | NULL                        | `api` \| `temporal_schedule` \| `webhook:{type}`                      |
| `trigger_ref`       | text        | NULL                        | Upstream schedule or delivery ID                                      |
| `requested_by`      | text        | NULL                        | User ID or `cogni_system`                                             |
| `scheduled_for`     | timestamptz | NULL                        | Set for scheduled runs from `TemporalScheduledStartTime`              |
| `started_at`        | timestamptz | NULL                        |                                                                       |
| `completed_at`      | timestamptz | NULL                        |                                                                       |
| `status`            | text        | NOT NULL, default 'pending' | `pending` / `running` / `success` / `error` / `skipped` / `cancelled` |
| `attempt_count`     | integer     | NOT NULL, default 0         | Retry/attempt semantics                                               |
| `langfuse_trace_id` | text        | NULL                        |                                                                       |
| `error_code`        | text        | NULL                        |                                                                       |
| `error_message`     | text        | NULL                        |                                                                       |

**Indexes:** `graph_runs_schedule_idx`, `graph_runs_scheduled_for_idx`, `graph_runs_run_id_idx`, `graph_runs_run_kind_idx`
**Unique:** `(schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL` — one scheduled run per slot
**Pattern:** Scheduled inserts use optimistic insert + re-select on duplicate because the uniqueness constraint is partial.

> **Note:** Current scheduler-worker writes only the scheduler-owned subset of `graph_runs`. API and webhook launches will share the same table once `GraphRunWorkflow` lands.

### `execution_requests`

| Column            | Type        | Constraints | Notes                                           |
| ----------------- | ----------- | ----------- | ----------------------------------------------- |
| `idempotency_key` | text        | PK          | `temporalScheduleId:TemporalScheduledStartTime` |
| `request_hash`    | text        | NOT NULL    | SHA256 of normalized request payload            |
| `run_id`          | text        | NOT NULL    |                                                 |
| `trace_id`        | text        | NULL        |                                                 |
| `ok`              | boolean     | NOT NULL    | Execution outcome                               |
| `error_code`      | text        | NULL        | `AiExecutionErrorCode` if `ok=false`            |
| `created_at`      | timestamptz | NOT NULL    |                                                 |

**Purpose:** Persists idempotency as the correctness layer for slot deduplication.
**Invariants:**

- If `idempotency_key` exists but `request_hash` differs, reject with 422 (payload mismatch)
- If `idempotency_key` exists and `request_hash` matches, return cached `{ok, runId, traceId, errorCode}` without re-executing
- Stores **both success and error outcomes** — retries return the cached outcome

---

## File Pointers

### Current (Implemented)

| File                                                                    | Purpose                                                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/scheduler-core/src/types.ts`                                  | `ExecutionGrant`, `ScheduleSpec`, `GraphRun` types                                              |
| `packages/db-schema/src/scheduling.ts`                                  | `execution_grants`, `schedules`, `graph_runs` tables                                            |
| `packages/scheduler-core/src/ports/execution-grant.port.ts`             | `ExecutionGrantPort` + error classes                                                            |
| `packages/scheduler-core/src/ports/execution-request.port.ts`           | `ExecutionRequestPort` for idempotency                                                          |
| `packages/scheduler-core/src/ports/schedule-manager.port.ts`            | `ScheduleManagerPort` interface                                                                 |
| `packages/scheduler-core/src/ports/schedule-run.port.ts`                | `ScheduleRunRepository` interface                                                               |
| `packages/db-client/src/adapters/drizzle-grant.adapter.ts`              | `DrizzleExecutionGrantAdapter`                                                                  |
| `packages/db-client/src/adapters/drizzle-execution-request.adapter.ts`  | `DrizzleExecutionRequestAdapter`                                                                |
| `packages/db-client/src/adapters/drizzle-schedule.adapter.ts`           | `DrizzleScheduleManagerAdapter`                                                                 |
| `packages/db-client/src/adapters/drizzle-run.adapter.ts`                | `DrizzleGraphRunAdapter` (node-app only; not used by worker)                                    |
| `services/scheduler-worker/src/adapters/run-http.ts`                    | `HttpGraphRunWriter`, `HttpExecutionGrantValidator` (worker's only persistence path, task.0280) |
| `packages/node-contracts/src/graph-runs.create.internal.v1.contract.ts` | `POST /api/internal/graph-runs` wire shape (task.0280)                                          |
| `packages/node-contracts/src/graph-runs.update.internal.v1.contract.ts` | `PATCH /api/internal/graph-runs/{runId}` wire shape (task.0280)                                 |
| `packages/node-contracts/src/grants.validate.internal.v1.contract.ts`   | `POST /api/internal/grants/{grantId}/validate` wire shape (task.0280)                           |
| `apps/operator/src/contracts/schedules.*.v1.contract.ts`                | Schedule CRUD contracts (4 files)                                                               |
| `apps/operator/src/app/api/v1/schedules/route.ts`                       | POST (create with credit gate), GET (list)                                                      |
| `apps/operator/src/app/api/v1/schedules/[scheduleId]/route.ts`          | PATCH (update), DELETE                                                                          |
| `apps/operator/src/bootstrap/container.ts`                              | Wire scheduling ports                                                                           |
| `packages/scheduler-core/src/payloads.ts`                               | Zod payload schemas                                                                             |

### Implemented (Temporal Migration)

| File                                                                     | Purpose                                     |
| ------------------------------------------------------------------------ | ------------------------------------------- |
| `packages/scheduler-core/src/ports/schedule-control.port.ts`             | `ScheduleControlPort` interface (no vendor) |
| `apps/operator/src/adapters/server/temporal/client.ts`                   | Temporal client factory                     |
| `apps/operator/src/adapters/server/temporal/schedule-control.adapter.ts` | `TemporalScheduleControlAdapter`            |
| `services/scheduler-worker/`                                             | Temporal worker service                     |
| `services/scheduler-worker/src/main.ts`                                  | Worker entry, connects to Temporal          |
| `services/scheduler-worker/src/workflows/`                               | GovernanceScheduledRunWorkflow              |
| `services/scheduler-worker/src/activities/`                              | validateGrant, createRun, executeGraph      |

### Implemented (P0)

| File                                                                  | Purpose                                     |
| --------------------------------------------------------------------- | ------------------------------------------- |
| `nodes/*/app/src/app/api/internal/graphs/[graphId]/runs/route.ts`     | Internal execution endpoint (per-node)      |
| `nodes/*/app/src/app/api/internal/graph-runs/route.ts`                | Create graph_runs row (task.0280, per-node) |
| `nodes/*/app/src/app/api/internal/graph-runs/[runId]/route.ts`        | Update graph_runs row (task.0280, per-node) |
| `nodes/*/app/src/app/api/internal/grants/[grantId]/validate/route.ts` | Validate grant (task.0280, per-node)        |
| `packages/node-contracts/src/graphs.run.internal.v1.contract.ts`      | Internal execution contract                 |

---

## Anti-Patterns

| Anti-Pattern                            | Why Forbidden                                   |
| --------------------------------------- | ----------------------------------------------- |
| Network calls in Temporal Workflow code | Non-deterministic; replays will fail            |
| Worker creates/modifies schedules       | CRUD endpoints are the single authority         |
| Reconciliation loop in worker           | Rebuilds control plane; creates authority split |
| Relying on workflowId for slot dedupe   | Use `execution_requests` table instead          |
| Using wall clock for scheduledFor       | Use `TemporalScheduledStartTime` attribute      |
| NextAuth sessions in workers            | Sessions expire; workers are long-lived         |
| Execution without idempotency key       | Retries cause duplicate runs                    |
| Worker imports graph code               | Couples to Next.js; prevents scaling            |
| Treating next_run_at as authoritative   | It's cache-only; Temporal is source of truth    |

---

## Auth & Boundary Summary

| Boundary                     | Auth                 | Precedent               |
| ---------------------------- | -------------------- | ----------------------- |
| User → Schedule API          | NextAuth session     | Existing                |
| Worker → Internal API        | Bearer shared secret | `METRICS_TOKEN` pattern |
| Internal API → GraphExecutor | In-process           | Same runtime            |

**Non-Negotiables:**

1. No user sessions in worker — use `ExecutionGrant` references only
2. No network-only auth — Bearer token required
3. Persist idempotency — `execution_requests` is the correctness layer
4. CRUD owns Temporal schedule lifecycle — worker is execution-only

---

## Related Documents

- [Temporal Patterns](temporal-patterns.md) — Canonical Temporal patterns and anti-patterns
- [Graph Execution](graph-execution.md) — Execution invariants, billing
- [Accounts Design](accounts-design.md) — Billing account lifecycle
- [Architecture](architecture.md) — Hexagonal pattern
- [Packages Architecture](packages-architecture.md) — Package boundaries and rules

## Sources

- [Temporal Schedules](https://docs.temporal.io/workflows#schedule) — Native cron replacement
- [Temporal TypeScript SDK](https://docs.temporal.io/develop/typescript) — Worker and client APIs
- [Temporal Search Attributes](https://docs.temporal.io/visibility#search-attribute) — TemporalScheduledStartTime
- [Stripe Idempotency](https://stripe.com/docs/api/idempotent_requests) — Idempotency key pattern

---

## Known Issues (P0)

- [ ] **Latest trace not displayed in UI**: `graph_runs.langfuse_trace_id` is populated after execution, but Schedules list API doesn't return run history—UI hardcodes "No runs yet" (`view.tsx:440`)

## Related

- [Scheduler Evolution Project](../../work/projects/proj.scheduler-evolution.md) — Roadmap, implementation checklists, P2/P3 plans
