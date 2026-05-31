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

**Server-only (server.ts)**

Unified serverEnv() provides all vars:

- NODE_ENV (development|test|production, default development)
- APP_ENV (test|production)
- SERVICE_NAME (default: "app") - for observability service label
- DEPLOY_ENVIRONMENT - deployment env label for metrics and analytics filtering
- DATABASE_URL (required, app_user role with RLS enforced)
- DATABASE_SERVICE_URL (required, app_service role with BYPASSRLS)
- LITELLM_BASE_URL (url, auto-detects: localhost:4000 for dev, litellm:4000 for production)
- LITELLM_MASTER_KEY
- PORT (default 3000)
- PINO_LOG_LEVEL (trace|debug|info|warn|error, default info)

Per DATABASE_RLS_SPEC.md design decision 7:

- Both DATABASE_URL and DATABASE_SERVICE_URL are required explicit DSNs
- No component-piece fallback (POSTGRES_USER, DB_HOST, etc. removed from runtime schema)
- Startup invariants reject same-user or superuser DSNs

Temporal (required infrastructure):

- TEMPORAL_ADDRESS (required, e.g., localhost:7233)
- TEMPORAL_NAMESPACE (required, e.g., cogni-test)
- TEMPORAL_TASK_QUEUE (optional, default scheduler-tasks)

Repo access:

- COGNI_REPO_PATH (required, e.g., "/repo/current" or ".") — explicit repo mount path, no cwd fallback
- COGNI_REPO_SHA (optional) — SHA override for git-sync worktree mounts without usable .git

Constructed:

- COGNI_REPO_ROOT — resolved from COGNI_REPO_PATH (required in all environments)

Optional:

- LITELLM_MVP_API_KEY (MVP wallet link single key - TODO: remove when proper wallet→key registry exists)
- OPENROUTER_API_KEY (for LiteLLM providers)
- AUTH_SECRET (≥32 chars) - TODO: when session management added
- METRICS_TOKEN (≥32 chars) - Bearer auth for /api/metrics endpoint
- BILLING_INGEST_TOKEN (≥32 chars) - Bearer auth for LiteLLM callback → billing ingest endpoint
- SCHEDULER_API_TOKEN (≥32 chars) - Bearer auth for scheduler-worker → internal graph execution API
- INTERNAL_OPS_TOKEN (≥32 chars) - Bearer auth for deploy-time internal ops endpoints
- PROMETHEUS_REMOTE_WRITE_URL (url) - Grafana Cloud write endpoint (must end with /api/prom/push)
- PROMETHEUS_QUERY_URL (url) - Explicit query endpoint (alternative to deriving from write URL)
- PROMETHEUS_READ_USERNAME - Basic auth username for Prometheus queries (read path)
- PROMETHEUS_READ_PASSWORD - Basic auth password for Prometheus queries (read-only token)
- ANALYTICS_K_THRESHOLD (int, default 50) - K-anonymity threshold for public analytics
- ANALYTICS_QUERY_TIMEOUT_MS (int, default 5000) - Prometheus query timeout

**Public client (client.ts)**

- NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID (optional; degrades to injected wallet only)

Rule: only NEXT*PUBLIC*\* keys may appear in client.ts.

## Responsibilities

- **Does:** validate env, type outputs, keep server/public split strict.
- **Does not:** read files, start processes, depend on frameworks.

## Usage

Server code:

```typescript
import { serverEnv } from "@shared/env";
const env = serverEnv(); // lazy function call
```

Client code:

```typescript
import { clientEnv } from "@shared/env";
```

Helpers (rare):

```typescript
import { getEnv, requireEnv } from "@shared/env";
```

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

- Lazy serverEnv() function prevents build-time database access
- assertRuntimeSecrets() validates secrets only at runtime (adapter methods, /health) to allow build without secrets
- Production-only memoization in assertRuntimeSecrets() prevents test false-passes while optimizing runtime
- AUTH_SECRET rotation can be added later via AUTH_SECRETS CSV when session management is implemented
- LITELLM_BASE_URL automatically detects deployment context (local dev vs Docker network)
