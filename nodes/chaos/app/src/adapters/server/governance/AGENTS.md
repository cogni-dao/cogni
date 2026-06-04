# governance · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Drizzle implementation of GovernanceStatusPort for system tenant governance visibility queries.

## Pointers

- [GovernanceStatusPort](../../../ports/governance-status.port.ts)
- [Governance Status API spec](../../../../../../docs/spec/governance-status-api.md)

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["adapters/server", "ports", "shared", "types"],
  "must_not_import": ["app", "features", "core"]
}
```

## Public Surface

- **Exports:** DrizzleGovernanceStatusAdapter
- **Env/Config keys:** DATABASE_URL
- **Files considered API:** drizzle-governance-status.adapter.ts

## Responsibilities

- This directory **does**: Query schedules and ai_threads tables for system tenant governance data
- This directory **does not**: Contain business logic, handle authentication, or manage user-scoped data

## Usage

```bash
pnpm typecheck
```

## Standards

- All queries filter by COGNI_SYSTEM_PRINCIPAL_USER_ID (system tenant scope)
- All queries wrapped in `withTenantScope(db, systemActorId)` — RLS enforced, no BYPASSRLS
- Return Date objects, not ISO strings (port contract)
- `getUpcomingRuns()` computes next occurrence from cron at query time (never returns stale DB cache)

## Dependencies

- **Internal:** ports, shared/db, shared/constants, `@cogni/db-client` (withTenantScope)
- **External:** drizzle-orm, cron-parser

## Change Protocol

- Update this file when **Exports** or **Env/Config** change
- Bump **Last reviewed** date
- Ensure boundary lint + contract tests pass

## Notes

- Adapter bound to `systemActorId` at construction (`userActor(toUserId(COGNI_SYSTEM_PRINCIPAL_USER_ID))`)
- Queries are bounded: LIMIT 3 for upcoming runs, LIMIT 10 for recent runs
