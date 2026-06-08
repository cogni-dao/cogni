# shared · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

App-local building blocks that cannot be extracted to `@cogni/node-shared` (env, db, hooks, config server, heavy-dep modules). Pure utilities, constants, observability helpers, and domain types live in `@cogni/node-shared`.

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

- **App-local exports:**
  - Environment validation (`serverEnv`, `clientEnv`) — reads `process.env`
  - Database schemas (Drizzle ORM) — `db/schema.ts`
  - Config server (`repoSpec.server.ts`) — file I/O + env
  - AI model catalog (`model-catalog.server.ts`) — LiteLLM fetch + env
  - Wagmi chain adapter (`evm-wagmi.ts`, `wagmi.config.ts`) — wagmi/chains runtime dep
  - Onchain client interface (`onchain/`) — viem types
  - Server logger (`observability/server/logger.ts`) — pino runtime
  - Metrics (`observability/server/metrics.ts`) — prom-client runtime
  - Redact paths (`observability/server/redact.ts`) — fast-safe-stringify
  - CSS utility (`util/cn.ts`) — clsx + tailwind-merge
  - React hook (`hooks/useIsMobile.ts`)
- **Re-exports from `@cogni/node-shared`:** observability barrels, web3 barrels, util barrels combine app-local + package exports
- **Env/Config keys:** `PINO_LOG_LEVEL`, `DATABASE_URL`, `LITELLM_*`, `APP_ENV`, `NODE_ENV`, `OPENFGA_API_URL`, `OPENFGA_STORE_ID`, `OPENFGA_AUTHORIZATION_MODEL_ID`, `OPENFGA_API_TOKEN`

## Responsibilities

- This directory **does**: Provide app-local env access, database schemas, server config, wagmi adapter, pino logger, prom-client metrics, and UI utilities
- This directory **does not**: Contain pure utilities (those live in `@cogni/node-shared`), import from ports/bootstrap/core/features/adapters, or handle HTTP routing

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

- **Internal:** `@cogni/node-shared`, shared/ only
- **External:** clsx, tailwind-merge, drizzle-orm (pg-core), pino, pino-pretty, prom-client, wagmi, @rainbow-me/rainbowkit

## Change Protocol

- Update this file when **Exports**, **Routes**, or **Env/Config** change
- Bump **Last reviewed** date
- Update ESLint boundary rules if **Boundaries** changed
- Ensure boundary lint + (if Ports) **contract tests** pass

## Notes

- Avoid framework-specific dependencies
