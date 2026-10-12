# scheduler-core · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable
- **Last reviewed:** 2026-10-12

## Purpose

Pure TypeScript types, port interfaces, and orchestration services for the scheduling domain. Defines contracts for schedule lifecycle, execution grants, execution requests, and schedule runs. Services depend only on ports/types (no adapters, no I/O).

## Pointers

- [Scheduler Spec](../../docs/spec/scheduler.md): Scheduling architecture and invariants
- [Temporal Patterns](../../docs/spec/temporal-patterns.md): Temporal patterns and anti-patterns

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
    "services"
  ]
}
```

**External deps:** `zod` (payload schemas), `type-fest` (JsonValue type). Internal deps: `@cogni/ids`.

## Public Surface

- **Exports:**
  - `ScheduleControlPort` - Vendor-agnostic schedule lifecycle control (create/update/pause/resume/delete/list/describe)
  - `ScheduleUserPort` - User-facing schedule CRUD (callerUserId: UserId)
  - `ExecutionGrantUserPort.ensureGrant` - Idempotent find-or-create grant
  - `syncGovernanceSchedules()` - Pure orchestration service for governance schedule sync
  - `ScheduleWorkerPort` - Worker-only schedule reads/updates (actorId: ActorId)
  - `ExecutionGrantUserPort` - User-facing grant create/revoke/delete (callerUserId: UserId)
  - `ExecutionGrantWorkerPort` - Worker-only grant validation (actorId: ActorId)
  - `ExecutionRequestPort` - Idempotency layer for execution requests
  - `GraphRunRepository` (canonical, `ScheduleRunRepository` deprecated alias) - Graph run persistence (single canonical run ledger)
  - `ScheduleSpec`, `GraphRun` (canonical, `ScheduleRun` deprecated alias), `ExecutionGrant`, `ExecutionRequest` - Domain types
  - `GRAPH_RUN_STATUSES`, `GRAPH_RUN_KINDS`, `GraphRunStatus`, `GraphRunKind` - Run status and kind enums
  - `ScheduleDescription` (includes config drift fields plus latest Schedule-started Workflow identity/status), `CreateScheduleParams` - Schedule control types
  - `IdempotencyCheckResult`, `ExecutionOutcome` - Execution request types
  - Error classes: `ScheduleControlUnavailableError`, `ScheduleControlConflictError`, `ScheduleControlNotFoundError`, grant errors, validation errors
  - Type guards: `isScheduleControl*Error`, `isGrant*Error`, `isSchedule*Error`
  - Payload schemas: `ExecuteScheduledRunPayloadSchema`, `ReconcileSchedulesPayloadSchema`
- **Files considered API:** `index.ts`

## Ports

- **Uses ports:** none
- **Implements ports:** none (defines port interfaces)

## Responsibilities

- This directory **does**: Define port interfaces, domain types, error classes, Zod payload schemas, and pure orchestration services
- This directory **does not**: Make I/O calls directly or depend on any adapter code

## Usage

```bash
pnpm --filter @cogni/scheduler-core typecheck
pnpm --filter @cogni/scheduler-core build
```

## Standards

- Per `FORBIDDEN`: No `@/`, `src/`, `drizzle-orm`, or any I/O
- Per `ALLOWED`: Pure TypeScript types/interfaces only
- All exports must be serialization-safe (no Date objects in port interfaces, use ISO strings)

## Dependencies

- **Internal:** `@cogni/ids` (branded ID types for port signatures)
- **External:** `zod` (payload schemas), `type-fest` (JsonValue type)

## Change Protocol

- Update this file when port interfaces or error types change
- Coordinate with SCHEDULER_SPEC.md invariants
- Bump **Last reviewed** date

## Notes

- `ScheduleControlPort` replaces the deprecated `JobQueuePort` (Graphile Worker)
- Per CRUD_IS_TEMPORAL_AUTHORITY: Only CRUD endpoints and governance sync use ScheduleControlPort
- Per WORKER_NEVER_CONTROLS_SCHEDULES: Worker service must not depend on ScheduleControlPort
- `services/syncGovernanceSchedules.ts` is pure orchestration — depends only on ports/types within this package
