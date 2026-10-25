# node-shared · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Shared pure utilities, constants, observability helpers, and domain types for all node apps. PURE_LIBRARY — no env vars, no process lifecycle, no framework deps, no heavy runtime deps (pino/prom-client/wagmi stay app-local).

## Pointers

- [Packages Architecture](../../docs/spec/packages-architecture.md)
- [Node App Shell Spec](../../docs/spec/node-app-shell.md)

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

## Public Surface

- **Exports (via `src/index.ts`):**
  - **AI:** content scrubbing, prompt hashing, citation guard, tool catalog
  - **Analytics:** PostHog capture helper, event name registry
  - **Auth:** `SessionUser`, `LinkIntent`, `linkIntentStore`, intent guards
  - **Config:** `RepoSpecSchema` (Zod schema only — server accessor stays app-local)
  - **Constants:** `COGNI_SYSTEM_BILLING_ACCOUNT_ID`, `COGNI_SYSTEM_PRINCIPAL_USER_ID`, payment constants
  - **Crypto:** `aeadEncrypt`, `aeadDecrypt` (AES-256-GCM)
  - **Errors:** `ChatValidationError`, `toUiError`
  - **Observability:** `EVENT_NAMES`, `logEvent`, `logRequestStart/End/Warn/Error`, `createRequestContext`, `clientLogger`, event payload types
  - **Schemas:** LiteLLM spend-log Zod schemas
  - **Time:** `deriveTimeRange`, `TIME_RANGE_PRESETS`
  - **Util:** `isValidUuid`, `deriveAccountIdFromApiKey`
  - **Utils:** `parseDollarsToCents`, `formatCentsToDollars`
  - **Web3:** `CHAIN_ID`, `CHAINS`, `USDC_TOKEN_ADDRESS`, ABIs, block explorer URLs, node-formation constants

## Responsibilities

- This directory **does**: Provide cross-node pure utilities, type definitions, constants, and Zod schemas
- This directory **does not**: Read env vars, import pino/prom-client/wagmi at runtime, contain UI components (cn.ts), define database schemas, or make I/O calls

## Usage

```bash
pnpm --filter @cogni/node-shared typecheck
pnpm --filter @cogni/node-shared build
```

## Dependencies

- **Internal:** `@cogni/node-core`
- **External:** `fast-safe-stringify`, `uuid`, `zod`
- **Peer (optional):** `pino` (type-only imports for Logger interface)

## Notes

- Extracted from `apps/operator/src/shared/` (task.0248 Phase 1b)
- App-local files remain in each app's `src/shared/`: env, db, hooks, config server, model-catalog, wagmi, evm-wagmi, onchain, logger, metrics, redact, cn
- Mixed barrels (`@/shared/observability`, `@/shared/web3`, `@/shared/util`) re-export from both local files and `@cogni/node-shared`

Schedule detail/history and saved-thread reads use registered metadata-only terminal events.
