# scheduler-worker-service · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

**SCHEDULER_WORKER_SERVICE:** Thin Temporal Worker composition root. Connects to Temporal, registers workflows from `@cogni/temporal-workflows`, wires activity implementations with concrete deps, and starts workers. Runs independently of the Next.js app, enabling horizontal scaling.

## Pointers

- [Scheduler Spec](../../docs/spec/scheduler.md) - Full scheduler specification
- [Temporal Patterns](../../docs/spec/temporal-patterns.md) - Temporal patterns and anti-patterns
- [Temporal Workflows Package](../../packages/temporal-workflows/AGENTS.md) - Workflow definitions + activity interfaces
- [Services Architecture](../../docs/spec/services-architecture.md) - Service structure guidelines

## Architecture

```
src/
├── bootstrap/       # Composition root: env parsing + adapter wiring
│   ├── env.ts       # Zod-validated env singleton (DATABASE_URL optional — ledger only)
│   └── container.ts # Builds ServiceContainer (HTTP adapters for scheduler path)
├── ports/           # Port interfaces + error classes (task.0280)
│   └── index.ts     # GraphRunHttpWriter, ExecutionGrantHttpValidator, RunHttpClientError, Grant*Error
├── activities/      # Temporal activities — HTTP-delegate run/grant persistence to owning node
├── adapters/        # Concrete implementations
│   ├── run-http.ts  # HttpGraphRunWriter + HttpExecutionGrantValidator (task.0280)
│   ├── operator-change-recovery-http.ts # recovery delegation; no GitHub credential
│   └── ingestion/   # GitHub poll adapter + webhook normalizer + token provider
├── observability/   # Logger factory (sole pino importer), redaction, metrics
├── main.ts          # Entry: env() → probeNodeReachability() → startSchedulerWorker() + optional ledger
├── worker.ts        # Per-node Temporal Workers (one per canonical nodeId + legacy drain queue)
├── ledger-worker.ts # Temporal Worker per node on ledger-tasks-<nodeId> (bug.5023: NO shared queue)
└── health.ts        # HTTP readiness probe
```

**Note:** Workflow definitions, activity type interfaces, activity profiles, and review domain logic live in `@cogni/temporal-workflows`. This service is the composition root that wires activities and starts workers.

### Hard rules (enforced by dep-cruiser)

- **WORKER_IS_DUMB**: scheduler-worker is a thin composition root. It wires activity implementations with concrete deps and starts Temporal workers. Domain-specific logic lives in packages.
- **SHARED_COMPUTE_HOLDS_NO_DB_CREDS** (task.0280): scheduler path holds zero DB credentials. Runs/grants flow through each node's internal HTTP API. Only the optional ledger path reads `DATABASE_URL`.
- **QUEUE_PER_NODE_ISOLATION** (task.0280 · bug.5023): EVERY queue is per-node `${prefix}-${nodeId}` — for BOTH `scheduler-tasks` AND `ledger-tasks`. One Worker per canonical (UUID) nodeId in `COGNI_NODE_ENDPOINTS`; a flapping node grows its own queue without starving siblings. Submitter (schedule) and poller (worker) MUST use the same `${prefix}-${nodeId}`. There is **no shared queue and no legacy drain on ledger.** Moving a schedule's queue only takes effect if drift-detection compares `taskQueue` (see `scheduler-core/syncGovernanceSchedules`), else the deployed schedule silently keeps firing on the old queue.
  - **story.5007 — finalize DELETED from the worker.** Epoch finalization no longer runs here at all: the operator app finalizes IN-PROCESS in its own route (`runFinalizeEpoch` from `@cogni/attribution-pipeline-plugins`). `FinalizeEpochWorkflow`, the `finalizeEpoch` activity, and every distribution/wallet/config-gateway dep (`walletResolver`, `distributionConfigClient`, the `distribution-config-http` adapter) are **removed** — one finalize path, no dead Temporal shadow. `ledger-tasks-<nodeId>` now carries **CollectEpoch only** (operator STAYS on CollectEpochWorkflow behind `OPERATOR_STAYS_ON_COLLECT_EPOCH`). Retiring `ledger-tasks` itself is the joint endpoint of the operator-collect cutover (task.5015), NOT this change.
  - ⚠️ **Changing a queue/worker is an INTEGRATION change. Unit-green does NOT prove pickup.** Prove it on a running Temporal — the stack test (`pnpm test:stack:dev`) or by finalizing a real epoch on candidate-a and reading Loki for the pickup — BEFORE you call it done.
  - ⚠️ **DEPLOY_COUPLING (no drain → app+worker are atomic):** a queue move touches the operator **app** (dispatch + schedule migration) AND this **scheduler-worker** (poller). With no legacy drain, they MUST ship from the SAME SHA together — `promote-and-deploy.yml` does (default targets = NODE_TARGETS **+ scheduler-worker**). A lone `candidate-flight` (app-only, per-node) ships the app half only → the migrated schedule fires on a queue no worker polls → **silent CollectEpoch starvation** (finalize is no longer at risk — story.5007 moved it in-process). Validate the worker half on promote, or co-deploy the scheduler-worker.
- **activities/ import ports only** — never adapters/, bootstrap/, or @cogni/db-client. Operator-change recovery is one thin HTTP-delegating Activity with a stable business idempotency key and maximum three Temporal attempts.
- **bootstrap/container.ts is the only place** that instantiates concrete adapters
- **observability/logger.ts is the only file** that imports pino directly
- **ports/ is interfaces + error classes only** — no runtime I/O, no framework deps

## Boundaries

```json
{
  "layer": "services",
  "may_import": ["packages"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "bootstrap",
    "types"
  ]
}
```

**Critical:**

- Per WORKER_NEVER_CONTROLS_SCHEDULES: Does NOT depend on `ScheduleControlPort`
- Schema access is transitive through `@cogni/db-client`
- SCHEDULER_API_TOKEN is a secret — never log it

## Public Surface

- **Exports:** none (standalone service, not a library)
- **CLI:** `pnpm --filter @cogni/scheduler-worker-service dev|build|start`
- **Env:** Validated in `src/bootstrap/env.ts` via Zod.
  - **Required**: `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE` (used as prefix; actual queues are `${prefix}-${nodeId}`), `SCHEDULER_API_TOKEN` (secret), `COGNI_NODE_ENDPOINTS` (must include UUID aliases — e.g. `operator=http://app:3000,4ff8eac1-...=http://app:3000,...`).
  - **Optional**: `DATABASE_URL` (ledger/attribution path only — scheduler path holds no DB creds), `GH_REVIEW_APP_ID`, `GH_REVIEW_APP_PRIVATE_KEY_BASE64`, `GH_REPOS`, `LOG_LEVEL`, `SERVICE_NAME`, `HEALTH_PORT`.
  - Identity (`node_id`, `scope_id`, `chain_id`) read from `.cogni/repo-spec.yaml` via `@cogni/repo-spec` at bootstrap (baked into Docker image).
- **Metrics:** `temporal_activity_duration_ms`, `temporal_activity_errors_total{error_type=retryable|non_retryable}`, `temporal_worker_info`, `scheduler_worker_node_reachable_at_boot{node_id}` (boot-time probe, never gates).
- **Files considered API:** `src/main.ts` (entry point), `Dockerfile`

## Responsibilities

- This directory **does**: Connect to Temporal; start one Worker per canonical nodeId (plus a legacy-queue drain Worker); register workflows from `@cogni/temporal-workflows` (GraphRunWorkflow, PrReviewWorkflow, CollectEpochWorkflow, CollectSourcesWorkflow, EnrichAndAllocateWorkflow); HTTP-delegate run/grant persistence to the owning node's internal API; dispatch enrichment and allocation via `@cogni/attribution-pipeline-plugins` registries.
- This directory **does not**: Define workflow logic (that's in `@cogni/temporal-workflows`); import from src/; hold any per-node DB credentials on the scheduler path; create/modify/delete schedules (CRUD is authority); define port interfaces that cross packages (those live in `@cogni/scheduler-core`).

## Dependencies

- **Internal:** `@cogni/temporal-workflows` (workflow defs, activity types, domain logic), `@cogni/node-contracts` (strict operator-change recovery wire contract), `@cogni/scheduler-core` (ports), `@cogni/ingestion-core` (ports), `@cogni/attribution-ledger` (domain logic + epoch window), `@cogni/attribution-pipeline-contracts` (enricher validation, profile resolution, allocator dispatch), `@cogni/attribution-pipeline-plugins` (built-in registries), `@cogni/db-client` (adapters, bootstrap only), `@cogni/repo-spec` (identity from `.cogni/repo-spec.yaml`), `@cogni/ids`
- **External:** `@temporalio/worker`, `@temporalio/activity`, `@octokit/webhooks-methods`, `pino`, `viem`, `zod`

## Change Protocol

- Update this file when env vars, activities, or layer boundaries change
- Coordinate with `@cogni/temporal-workflows` AGENTS.md when activity signatures change
- Changes require updating docker-compose.dev.yml

## Notes

- Per NO_WORKER_RECONCILIATION: Temporal handles scheduling natively
- Per SCHEDULED_TIMESTAMP_FROM_TEMPORAL: scheduledFor comes from Schedule action
- Per EXECUTION_VIA_SERVICE_API: executeGraphActivity calls internal API with Idempotency-Key
- Workflow definitions extracted to `@cogni/temporal-workflows` (bug.0193)
