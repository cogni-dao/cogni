# db · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Database client singletons and tenant-scoping helpers for PostgreSQL access. App-role (`getAppDb`) and service-role (`getServiceDb`) singletons are in separate files to enable dependency-cruiser enforcement of BYPASSRLS isolation.

## Pointers

- [Database schema](../../../shared/db/schema.ts)
- [Drizzle configuration](../../../../../../drizzle.config.ts)

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["adapters/server", "ports", "shared", "types"],
  "must_not_import": ["app", "features", "core"]
}
```

## Public Surface

- **Exports (via `client.ts` barrel):** `Database` type, `getAppDb()`, `setTenantContext`, `withTenantScope`
- **Exports (via `drizzle.service-client.ts`, NOT in barrel):** `getServiceDb()` (service-role singleton, BYPASSRLS). Only `src/auth.ts` and `src/bootstrap/container.ts` may import this (enforced by depcruiser `no-service-db-adapter-import` rule).
- **Env/Config keys:** `DATABASE_URL`, `DATABASE_SERVICE_URL`
- **Files considered API:** `client.ts` (safe barrel), `drizzle.service-client.ts` (restricted)

## Responsibilities

- This directory **does**: Provide configured database singletons (`getAppDb`, `getServiceDb`) and tenant-scoping helpers for other adapters
- This directory **does not**: Contain business logic or table operations
- This directory **enforces**: BYPASSRLS isolation — `getServiceDb` is NOT in the barrel, requiring direct import from `drizzle.service-client.ts` with depcruiser allowlisting

## Usage

Minimal local commands:

```bash
pnpm test tests/component/db/
pnpm db:migrate
```

## Standards

- Uses Drizzle ORM for type-safe database access
- Connection pooling and transaction support
- Migration management through Drizzle

## Dependencies

- **Internal:** shared/db (schema), shared/env (serverEnv), `@cogni/db-client` (app factory), `@cogni/db-client/service` (service factory)
- **External:** drizzle-orm, postgres

## Change Protocol

- Update this file when **Exports** or **Env/Config** change
- Bump **Last reviewed** date
- Ensure component tests pass

## Notes

- Contains migration files in migrations/ subdirectory
- Shared by all database adapters (accounts, etc.)
