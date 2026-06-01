# adapters · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Infrastructure implementations of ports including server/, worker/, cli/, and test/ adapters. No UI.

## Pointers

- [Root AGENTS.md](../../../../AGENTS.md)
- [Architecture](../../../../docs/spec/architecture.md)

## Boundaries

```json
{
  "layer": "adapters",
  "may_import": ["adapters", "ports", "shared", "types"],
  "must_not_import": ["app", "features", "core"]
}
```

## Public Surface

- **Exports:** Port implementations for bootstrap injection (UserDrizzleAccountService via barrel; ServiceDrizzleAccountService via direct import), database client (db, Database), MimirMetricsAdapter, ViemEvmOnchainClient, EvmRpcOnChainVerifierAdapter, EvmOnchainClient (type), GitHubWebhookNormalizer (ingestion), scheduling adapters (re-exported from @cogni/db-client)
- **CLI (if any):** cli/ adapter implementations
- **Env/Config keys:** DATABASE_URL, LITELLM_BASE_URL, LITELLM_MASTER_KEY, PROMETHEUS_QUERY_URL, PROMETHEUS_READ_USERNAME, PROMETHEUS_READ_PASSWORD, ANALYTICS_QUERY_TIMEOUT_MS, EVM_RPC_URL
- **Files considered API:** Port implementation exports, database client, onchain client interfaces

## Ports (optional)

- **Uses ports:** none
- **Implements ports:** All ports defined in ports/
- **Contracts (required if implementing):** tests/contract/ must pass for all implementations

## Responsibilities

- This directory **does**: Implement ports, handle external services, provide concrete infrastructure
- This directory **does not**: Contain UI, business logic, or framework routing

## Usage

Minimal local commands:

```bash
pnpm test tests/component/
pnpm test tests/contract/
```

## Standards

- Contract tests required for all port implementations
- Component tests against real services

## Dependencies

- **Internal:** ports/, shared/
- **External:** drizzle-orm, postgres, langfuse, pino, siwe, viem, litellm

## Change Protocol

- Update this file when **Exports**, **Routes**, or **Env/Config** change
- Bump **Last reviewed** date
- Update ESLint boundary rules if **Boundaries** changed
- Ensure boundary lint + (if Ports) **contract tests** pass

## Notes

- No UI components allowed in adapters/
- ViemEvmOnchainClient uses lazy initialization (getClient()) to allow Docker builds without EVM_RPC_URL
- Configuration validation happens on first RPC method call, not at construction
- /readyz probe exercises EVM RPC connectivity via assertEvmRpcConnectivity() (3s timeout budget)
- This catches missing/invalid EVM_RPC_URL immediately after deploy, before first payment
