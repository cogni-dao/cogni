# db-client · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable
- **Last reviewed:** 2026-11-01

## Purpose

Database client factory and Drizzle adapter implementations for scheduling and ledger domain ports. Provides portable database access for the scheduler-worker service without framework dependencies.

## Pointers

- [Scheduler Spec](../../docs/spec/scheduler.md): Scheduling architecture and invariants
- [Database RLS Spec](../../docs/spec/database-rls.md): RLS tenant isolation design
- [Packages Architecture](../../docs/spec/packages-architecture.md): Package isolation boundaries
- [scheduler-core](../scheduler-core): Port interfaces implemented by adapters

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

**External deps:** `drizzle-orm`, `postgres`, `type-fest`. Internal deps: `@cogni/db-schema` (ledger + identity tables), `@cogni/attribution-ledger`, `@cogni/scheduler-core`, `@cogni/ai-core`, `@cogni/ids`.

## Public Surface

- **Exports (root `@cogni/db-client`):**
  - `createAppDbClient(url, options?)` — client factory for `app_user` role (RLS enforced); injected `DbClientOptions` bounds process pool size and names the consumer; optional public socket/TLS construction options let the injecting owner seal and dispose its own transport; `fetchTypes` controls automatic array-type discovery for consumers that use only scalar and JSONB values
  - `withTenantScope(db, actorId, fn)` — transaction wrapper setting RLS context
  - `setTenantContext(tx, actorId)` — sets RLS context in existing transaction
  - `Database`, `DbClientOptions`, `LoggerLike` — Drizzle client type (includes `$client: Sql` for pool control), optional pool configuration, and logger interface
  - `DrizzleScheduleUserAdapter`, `DrizzleScheduleWorkerAdapter` — schedule adapters (split by trust boundary)
  - `DrizzleExecutionGrantUserAdapter`, `DrizzleExecutionGrantWorkerAdapter` — grant adapters (split by trust boundary)
  - `DrizzleExecutionRequestAdapter`, `DrizzleGraphRunAdapter` (canonical), `DrizzleScheduleRunAdapter` (deprecated alias)
  - `DrizzleAttributionAdapter` — ledger adapter (shared by app + worker, uses serviceDb/BYPASSRLS). Constructor takes `scopeId`; all epochId-based methods enforce scope via `resolveEpochScoped()` (SCOPE_GATED_QUERIES).
  - Re-exports from `@cogni/db-schema` (tables, types)
- **Exports (sub-path `@cogni/db-client/service`):**
  - `createServiceDbClient(url, options?)` — client factory for `app_service` role (BYPASSRLS), accepting the same optional pool configuration
- **Env/Config keys:** none (accepts DATABASE_URL via factory parameter)
- **Files considered API:** `index.ts` (root), `service.ts` (sub-path)

## Ports

- **Uses ports:** none
- **Implements ports:** `ScheduleUserPort`, `ScheduleWorkerPort`, `ExecutionGrantUserPort`, `ExecutionGrantWorkerPort`, `ExecutionRequestPort`, `GraphRunRepository` (canonical, `ScheduleRunRepository` deprecated alias), `ActivityLedgerStore`
- **Contracts:** Contract tests in `tests/contract/<port>.contract.ts`

## Responsibilities

- This directory **does**: Provide Drizzle-based adapter implementations for scheduling and ledger ports
- This directory **does not**: Access process.env, contain business logic, or depend on Next.js

## Usage

```bash
pnpm --filter @cogni/db-client typecheck
pnpm --filter @cogni/db-client build
```

## Standards

- Per FORBIDDEN: No `@/`, `src/`, `process.env`, or Next.js imports
- Per ALLOWED: Pure database operations via Drizzle ORM
- Adapters implement port interfaces from `@cogni/scheduler-core` and `@cogni/attribution-ledger`

## Dependencies

- **Internal:** `@cogni/db-schema`, `@cogni/attribution-ledger`, `@cogni/scheduler-core`, `@cogni/ai-core`, `@cogni/ids`
- **External:** `drizzle-orm`, `postgres`, `type-fest`

## Change Protocol

- Update this file when exports or port implementations change
- Bump **Last reviewed** date
- Ensure contract tests pass for implemented ports

## Notes

- Re-exports scheduling schema so consumers (scheduler-worker) get schema transitively
- All adapters accept a `Database` instance via constructor (dependency injection)
- `createServiceDbClient` is isolated in `./service` sub-path; root barrel does NOT re-export it
- `Database` type is `ReturnType<typeof buildClient>` — preserves drizzle's `$client` accessor for `reserve()`, `begin()`, etc.
- `Database` type lives in root only — not exported from `./service`
