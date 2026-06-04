# shared · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Low-level building blocks used across the repo. Primitives, DTO mappers, pure utilities, database schemas, environment validation, and cross-cutting observability (logging, request context).

## Pointers

- [Root AGENTS.md](../../../../AGENTS.md)
- [Architecture](../../../../docs/spec/architecture.md)
- **Related:** [contracts](../contracts/) (external IO specs), [types](../types/) (compile-time only)

## Boundaries

```json
{
  "layer": "shared",
  "may_import": ["shared"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters/server",
    "adapters/worker"
  ]
}
```

## Public Surface

- **Exports:**
  - Environment validation (`serverEnv`, `clientEnv`)
  - Database schemas (auth, billing)
  - Utilities (cn, uuid, accountId)
  - Time utilities (TimeRange presets, deriveTimeRange)
  - Constants (payments, web3)
  - Observability (Logger, RequestContext, log helpers, event schemas)
  - AI model catalog (cache)
  - Shared errors (`TooManyLogsError`, `MAX_LOGS_PER_RANGE`)
- **Env/Config keys:** `PINO_LOG_LEVEL`, `DATABASE_URL`, `LITELLM_*`, `APP_ENV`, `NODE_ENV`
- **Files considered API:** `index.ts`, `env/index.ts`, `observability/index.ts`

## Responsibilities

- This directory **does**:
  - Provide pure utilities, constants, environment validation
  - Define database schemas (Drizzle)
  - Provide observability infrastructure (logging, context, events)
  - Provide AI model catalog cache
- This directory **does not**:
  - Contain business logic or domain rules
  - Import from ports, bootstrap, core, features, adapters
  - Handle HTTP routing or responses

## Usage

Minimal local commands:

```bash
pnpm test tests/unit/shared/
pnpm typecheck
```

## Standards

- Keep small and pure
- Promote growing parts into core or new port
- No versioning policy here; stability comes from the contracts that compose them
- Keep `shared/` small and pure. Promote growing parts into `core` or a new `port`

## Dependencies

- **Internal:** shared/ only
- **External:** zod, clsx, tailwind-merge, drizzle-orm (pg-core), pino, pino-pretty

## Change Protocol

- Update this file when **Exports**, **Routes**, or **Env/Config** change
- Bump **Last reviewed** date
- Update ESLint boundary rules if **Boundaries** changed
- Ensure boundary lint + (if Ports) **contract tests** pass

## Notes

- Avoid framework-specific dependencies
