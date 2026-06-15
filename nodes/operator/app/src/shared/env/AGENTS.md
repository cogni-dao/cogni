# env · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Single source of truth for environment variables. Lazy validation with Zod prevents build-time access. Separates server-only and public client vars. Includes APP_ENV for adapter selection.

## Pointers

- [Root AGENTS.md](../../../../../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)

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
    "adapters/worker",
    "adapters/cli",
    "mcp"
  ]
}
```

## Public Surface

**Exports:**

- `server.ts`: serverEnv() (unified lazy function)
- `client.ts`: clientEnv (typed object)
- `invariants.ts`: assertEnvInvariants(), assertRuntimeSecrets(), assertEvmRpcConfig(), assertEvmRpcConnectivity(), assertTemporalConnectivity(), RuntimeSecretError, InfraConnectivityError
- `index.ts`: re-exports + getEnv, requireEnv

**Files considered API:** server.ts, client.ts, index.ts
**Routes/CLI:** none
**Env/Config keys:** defined below

## File Map

- `server-env.ts` → All env validation logic (Zod schema, `serverEnv()`, `EnvValidationError`). No `server-only` guard — safe for bootstrap/job code under plain Node.
- `server.ts` → Thin re-export of `server-env.ts` with `import "server-only"` guard. Next.js routes import through this.
- `client.ts` → public, browser-safe vars (NEXT*PUBLIC*\* only).
- `invariants.ts` → cross-field validation and runtime secret checks. assertEnvInvariants() runs after Zod parse. assertRuntimeSecrets() validates secrets at adapter boundaries (not during build).
- `index.ts` → re-exports from `server.ts` (preserving `server-only` guard) + tiny helpers.

## Vars by layer

**Server-only (`server.ts`)**

- Runtime: `NODE_ENV`, `APP_ENV`, `SERVICE_NAME`, `DEPLOY_ENVIRONMENT`, `PORT`, `PINO_LOG_LEVEL`
- Database: `DATABASE_URL`, `DATABASE_SERVICE_URL`; both are explicit DSNs, no component-piece fallback, startup rejects same-user/superuser DSNs
- LLM/billing/ops: `LITELLM_BASE_URL`, `LITELLM_MASTER_KEY`, `LITELLM_MVP_API_KEY`, `OPENROUTER_API_KEY`, `BILLING_INGEST_TOKEN`, `SCHEDULER_API_TOKEN`, `INTERNAL_OPS_TOKEN`
- Auth/session: `AUTH_SECRET`
- Authorization: `OPENFGA_API_URL`, `OPENFGA_STORE_ID`, `OPENFGA_AUTHORIZATION_MODEL_ID`, `OPENFGA_API_TOKEN`; `OPENFGA_STORE_ID` is required when OpenFGA activation vars are present
- Metrics/analytics: `METRICS_TOKEN`, `PROMETHEUS_REMOTE_WRITE_URL`, `PROMETHEUS_QUERY_URL`, `PROMETHEUS_READ_USERNAME`, `PROMETHEUS_READ_PASSWORD`, `ANALYTICS_K_THRESHOLD`, `ANALYTICS_QUERY_TIMEOUT_MS`
- Temporal: `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`
- Repo access: `COGNI_REPO_PATH`, `COGNI_REPO_SHA`; `COGNI_REPO_ROOT` is derived from `COGNI_REPO_PATH`
- DoltHub: `DOLTHUB_OWNER`, `DOLTHUB_API_TOKEN`, `DOLTHUB_OAUTH_CLIENT_ID`, `DOLTHUB_OAUTH_CLIENT_SECRET`

**Public client (`client.ts`)**

- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`; only `NEXT_PUBLIC_*` keys may appear in client env.

## Responsibilities

- **Does:** validate env, type outputs, keep server/public split strict.
- **Does not:** read files, start processes, depend on frameworks.

## Usage

Server code calls `serverEnv()` lazily. Client code imports `clientEnv`. Helpers `getEnv` and `requireEnv` are rare.

## Standards

- Use Zod for all validation.
- No framework-specific imports.
- Do not access process.env outside this module.

## Dependencies

- **External:** zod
- **Internal:** none

## Change Protocol

When adding/removing keys, update:

- schema in server.ts or client.ts,
- buildDatabaseUrl function in @shared/db if DB-related,
- Vars by layer list above,
- .env.local.example,
- tests touching env.

Bump Last reviewed date. Ensure pnpm lint && pnpm typecheck pass.

## Notes

- Lazy `serverEnv()` prevents build-time database access.
- `assertRuntimeSecrets()` validates secrets only at runtime and memoizes only in production.
- AUTH_SECRET rotation can be added later via AUTH_SECRETS CSV when session management is implemented
- LITELLM_BASE_URL automatically detects deployment context (local dev vs Docker network)
- Empty-string secrets from k8s Secret manifests must use the `optionalString` helper, not `z.string().optional()` — the latter rejects `""` and breaks `/readyz` (PR #1166).
