# temporal-workflows · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

**TEMPORAL_WORKFLOWS_PACKAGE:** Shared Temporal workflow definitions, activity type interfaces, activity retry profiles, and PR review domain logic. Consumed by the scheduler-worker service (via `workflowsPath`) and the web app (for type-safe workflow input construction). Contains zero I/O — pure deterministic code only.

## Pointers

- [Temporal Patterns Spec](../../docs/spec/temporal-patterns.md) - Workflow/activity patterns and anti-patterns
- [Packages Architecture](../../docs/spec/packages-architecture.md) - Package structure guidelines
- [Scheduler Spec](../../docs/spec/scheduler.md) - Scheduled graph execution

## Architecture

```
src/
├── index.ts                # Public type exports ONLY (safe to import anywhere)
├── scheduler.ts            # Barrel: scheduler-queue workflows (workflowsPath)
├── ledger.ts               # Barrel: CollectEpoch, Finalize, stages (workflowsPath)
├── activity-types.ts       # Explicit activity interfaces for proxyActivities<T>()
├── activity-profiles.ts    # Shared timeout/retry configs
├── domain/
│   └── review.ts           # Pure domain logic: criteria eval + markdown formatting
└── workflows/
    ├── graph-run.workflow.ts
    ├── pr-review.workflow.ts
    ├── pr-review.schema.ts    # Zod source-of-truth for PrReviewWorkflowInput
    ├── operator-change-recovery.schema.ts
    ├── operator-change-recovery.workflow.ts
    ├── collect-epoch.workflow.ts
    ├── finalize-epoch.workflow.ts
    └── stages/
        ├── collect-sources.workflow.ts
        └── enrich-and-allocate.workflow.ts
```

### Hard rules

- **TEMPORAL_DETERMINISM**: No I/O, network calls, or LLM invocations in workflow code. All external calls run in Activities only.
- **NO_SRC_IMPORTS**: Package never imports `@/` or `src/**` paths.
- **NO_SERVICE_IMPORTS**: Package never imports from `services/`.
- **SUBPATH_ISOLATION**: Main entry (`@cogni/temporal-workflows`) exports types + pure functions only. Workflow functions only via `/scheduler` and `/ledger` subpath exports.
- **PURE_LIBRARY**: No process lifecycle, no env vars, no health checks.

## Boundaries

```json
{
  "layer": "packages",
  "may_import": ["packages"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "bootstrap",
    "services"
  ]
}
```

## Public Surface

- **Types:** `GraphRunResult`, `GraphRunWorkflowInput`, `PrReviewWorkflowInput` (`z.infer<typeof PrReviewWorkflowInputSchema>` from `./pr-review.schema.ts`), `FinalizeEpochWorkflowInput`, `AttributionIngestRunV1`, `CollectSourcesInput`, `EnrichAndAllocateInput`
- **Schemas:** `PrReviewWorkflowInputSchema` (Zod, `.strict()`) — single source of truth for `PrReviewWorkflow`'s input. Producers parse with this before `workflowClient.start(...)` per SINGLE_INPUT_CONTRACT (task.0419).
- **Activity interfaces:** `SchedulerActivities`, `ReviewActivities`, `OperatorChangeRecoveryActivities`, `LedgerActivities`, `EnrichmentActivities`. Per task.0280, `validateGrantActivity` / `createGraphRunActivity` / `updateGraphRunActivity` inputs include `nodeId: string` so the worker can route each HTTP call to the owning node's internal API. Per task.0410, `fetchPrContextActivity` returns `{ changedFiles, owningNode }` and `postRoutingDiagnosticActivity` handles cross-domain refusal + miss-neutral outcomes.
- **Domain exports:** `evaluateCriteria`, `aggregateGateStatuses`, `formatCheckRunSummary`, `formatPrComment`, `formatCrossDomainRefusal`, `formatNoScopeNeutral`, `buildReviewUserMessage`, `findRequirement`, `formatThreshold`
- **Config:** `STANDARD_ACTIVITY_OPTIONS`, `EXTERNAL_API_ACTIVITY_OPTIONS`, `GRAPH_EXECUTION_ACTIVITY_OPTIONS`, `OPERATOR_CHANGE_RECOVERY_ACTIVITY_OPTIONS`. Recovery transport retries are capped at three and the workflow contains no polling loop.

## Responsibilities

- This directory **does**: Define Temporal workflow orchestration functions, declare activity type interfaces, export shared retry/timeout profiles, export PR review domain logic (pure)
- This directory **does not**: Contain activity implementations, perform I/O, import from services/ or src/, define process lifecycle

## Dependencies

- **Internal:** `@cogni/attribution-ledger` (epoch window computation), `@cogni/ingestion-core` (ActivityEvent type), `@cogni/repo-spec` (SuccessCriteria types for review domain)
- **External:** `@temporalio/workflow`

## Change Protocol

- Update this file when workflows, activity interfaces, or exports change
- Coordinate with scheduler-worker AGENTS.md when activity signatures change

## Notes

- Per TEMPORAL_DETERMINISM: all workflow code is deterministic — no I/O
- Per SUBPATH_ISOLATION: main entry exports types only; workflow functions via subpath exports
- Workflow files were git mv'd from services/scheduler-worker/ to preserve git history
