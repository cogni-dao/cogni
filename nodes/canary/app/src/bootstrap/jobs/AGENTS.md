# bootstrap/jobs · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Job modules that wire business logic to the application container for ops-triggered tasks (CLI and internal routes). Each job acquires an advisory lock, resolves dependencies from the container, and delegates to a service function.

## Pointers

- [Bootstrap AGENTS.md](../AGENTS.md)
- [Governance Scheduling Spec](../../../../../docs/spec/governance-scheduling.md)

## Boundaries

```json
{
  "layer": "bootstrap",
  "may_import": ["bootstrap", "ports", "adapters/server", "shared", "types"],
  "must_not_import": ["app", "features", "core", "contracts"]
}
```

## Public Surface

- **Exports:** `runGovernanceSchedulesSyncJob()`
- **CLI (if any):** `pnpm governance:schedules:sync` (calls internal ops route)
- **Files considered API:** `syncGovernanceSchedules.job.ts`

## Ports (optional)

- **Uses ports:** `ScheduleControlPort`, `ExecutionGrantUserPort`
- **Implements ports:** none

## Responsibilities

- This directory **does**: Acquire advisory locks, resolve container deps, call service functions
- This directory **does not**: Contain business logic, expose HTTP routes, manage process lifecycle

## Usage

```bash
pnpm governance:schedules:sync  # POST /api/internal/ops/governance/schedules/sync
```

## Standards

- Jobs use `pg_advisory_lock` for single-writer safety
- Jobs import services from `@cogni/scheduler-core`, not from features

## Dependencies

- **Internal:** `@cogni/scheduler-core`, `@/bootstrap/container`, `@/adapters/server`, `@/shared/config`, `@/shared/constants`
- **External:** `drizzle-orm` (sql template tag)

## Change Protocol

- Update this file when adding new job modules
- Bump **Last reviewed** date

## Notes

- Job files are exempted from `no-internal-adapter-imports` and `no-service-db-adapter-import` dep-cruiser rules
