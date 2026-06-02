# tests/\_fixtures/db · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable

## Purpose

Database fixture helpers for component tests. Provides a service-role (BYPASSRLS) database client for test seeding and cleanup operations.

## Pointers

- [testcontainers global setup](../../component/setup/testcontainers-postgres.global.ts)
- [Database RLS Spec](../../../../../docs/spec/database-rls.md): RLS architecture

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["packages"],
  "must_not_import": ["adapters", "core", "features", "app", "ports"]
}
```

## Public Surface

- **Exports:**
  - `getSeedDb()` — lazy service-role database singleton (BYPASSRLS) for test INSERT/DELETE
- **Env/Config keys:** `DATABASE_SERVICE_URL` (set by testcontainers global setup)
- **Files considered API:** `seed-client.ts`

## Ports

- **Uses ports:** none
- **Implements ports:** none

## Responsibilities

- This directory **does**: Provide BYPASSRLS database access for test fixture seeding and cleanup
- This directory **does not**: Provide app-role access, contain test assertions, or run application code

## Usage

```bash
pnpm test:component
```

## Standards

- Test code uses `getSeedDb()` for INSERT/DELETE (seeding) and SELECT assertions (BYPASSRLS)
- Requires `DATABASE_SERVICE_URL` in env (set by testcontainers global setup)

## Dependencies

- **Internal:** `@cogni/db-client`, `@cogni/db-client/service`
- **External:** none

## Change Protocol

- Update this file when **Exports** or **Env/Config** change
- Bump **Last reviewed** date

## Notes

- `getSeedDb()` connects via `DATABASE_SERVICE_URL`, not `DATABASE_URL`
- Lazy singleton — connects on first access only
