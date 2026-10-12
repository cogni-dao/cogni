# bootstrap/jobs · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Job modules that wire business logic or bounded substrate diagnostics to the application environment for ops-triggered tasks and routes.

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

- **Exports:** `runGovernanceSchedulesSyncJob()`, `runCatalogNodeRegistryReconcileJob()`, `checkSharedTemporalHealth()` (pollers + effective reconciled declarations/full schedule spec + semantic result/cadence health, process single-flight + short cache)
- **CLI (if any):** `pnpm governance:schedules:sync`; `pnpm temporal:health` calls the authenticated, `node.flight`-gated API route and independently binds the app SHA to public `/version`
- **Files considered API:** job modules in this directory

## Ports (optional)

- **Uses ports:** `ScheduleControlPort`, `ExecutionGrantUserPort`, `CatalogNodeRegistryPort`, `DeployPlanePort`, `AuthorizationPort`
- **Implements ports:** none

## Responsibilities

- This directory **does**: Acquire advisory locks, resolve dependencies, call services and bounded read-only substrate diagnostics
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
