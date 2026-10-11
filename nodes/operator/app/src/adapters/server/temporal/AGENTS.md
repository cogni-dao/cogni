# temporal · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Last reviewed:** 2026-10-11
- **Status:** stable

## Purpose

Temporal schedule control plus read-only, server-observed shared-worker health diagnostics.

## Pointers

- [Scheduler Spec](../../../../../../docs/spec/scheduler.md): Schedule architecture and invariants
- [Temporal Patterns](../../../../../../docs/spec/temporal-patterns.md): Temporal patterns and anti-patterns
- [ScheduleControlPort](../../../../../../packages/scheduler-core/src/ports/schedule-control.port.ts): Port interface

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["adapters/server", "ports", "shared", "types"],
  "must_not_import": ["app", "features", "core"]
}
```

**External deps:** `@temporalio/client` (Temporal SDK), `@cogni/scheduler-core` (port types via workspace package).

## Public Surface

- **Exports:** schedule control types and shared Temporal health inspection/types
- **Env/Config keys:** `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `SCHEDULER_WORKER_HEALTH_URL`
- **Files considered API:** `index.ts`

## Ports

- **Uses ports:** none
- **Implements ports:** `ScheduleControlPort`
- **Contracts:** Contract tests in `tests/contract/schedule-control.contract.ts` (pending)

## Responsibilities

- This directory **does**: Implement schedule lifecycle control and read server-observed pollers plus worker identity
- This directory **does not**: Handle workflow execution, graph logic, or worker tasks

## Usage

```bash
# Start Temporal infrastructure
pnpm dev:infra

# Run stack tests (requires Temporal)
pnpm test:stack
```

## Standards

- Per `CRUD_IS_TEMPORAL_AUTHORITY`: Only CRUD endpoints and governance sync use these adapters
- Per `WORKER_NEVER_CONTROLS_SCHEDULES`: Worker service must not depend on ScheduleControlPort
- Temporal is required infrastructure - app fails to start without TEMPORAL_ADDRESS configured

## Dependencies

- **Internal:** `@cogni/scheduler-core` (port interface)
- **External:** `@temporalio/client` (Temporal SDK)

## Change Protocol

- Update this file when exports or env keys change
- Bump **Last reviewed** date
- Ensure `pnpm check:docs` passes

## Notes

- Temporal adapter hardcodes `overlap=SKIP` and `catchupWindow=0` per spec
- Connection is lazy - only connects when first schedule operation is called
- `updateSchedule()` preserves existing schedule state (pause, notes) via `previous.state`
- `describeSchedule()` returns input from action args; cron returns null (Temporal compiles crons to calendars)
