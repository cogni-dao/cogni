# adapters · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable
- **Last reviewed:** 2026-11-04

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

- Node mesh (`server/node-deploy/headscale.adapter.ts`, task.5429): `HeadscaleSocketAdapter` implements `NodeMeshPort` over ONE env Headscale v0.29.7's unix socket (gRPC, no API key, bounded deadlines, normalized payload-free errors). Its schema is `headscale-v0.29.7.descriptor.ts`, drift-pinned to the vendored protos in `headscale-proto-v0.29.7/` (BSD-3-Clause, LICENSE beside them). Contract test: `tests/component/node-deploy/headscale.adapter.int.test.ts`. Not exported through `@/adapters/server`; the sequencer bootstrap wires it (T4).

- App-private `AkashNativeStateReader` (exported through `@/adapters/server`) reads only fixed public Akash deployment/lease GETs. Bootstrap injects public owner and transport; full identities, pagination, bytes, concurrency and deadlines are bounded. It returns observations, never closure or recovery policy.

- Finance (`server/finance/`): `akashHostingReaders` (one operator-covered USD/day row per node from the exact on-chain lease price, measured blocks/day or 5.884 s/block), `akashCreditReader` (injected expected Console granter; verified available-credit/burn estimate, escrow excluded) + `readAkashBlocksPerDay`, `cherryFinanceReader` (port of `cherryPlane`), `grafanaOverageReader`, `domainExpiryReader`, `readAkashReports`, `collapseAkash` (hosting rows become children of the one Akash row), `creditedPurchasesQuery` (CREDITED payment_attempts for the package income reader), `unavailableFinanceReader` — every row in the hub money-plane-registry as a never-throwing `PlaneReader`, each carrying its `rail`.

- **Exports:** Port implementations for bootstrap injection (including identity-attestation live-catalog/Drizzle/Jose adapters and receipt-linked `DrizzleComputeCostStore`), database client (db, Database), MimirMetricsAdapter, ViemEvmOnchainClient, EvmRpcOnChainVerifierAdapter, EvmOnchainClient (type), GitHubWebhookNormalizer (ingestion), GitHubRepoWriter (operator App-backed deploy plane, including candidate legacy-intent cancellation, production infra reconcile and fixed worker-routing receipt rollback), scheduling adapters (re-exported from @cogni/db-client)
- **CLI (if any):** cli/ adapter implementations
- **Env/Config keys:** DATABASE_URL, LITELLM_BASE_URL, LITELLM_MASTER_KEY, FLEET_CONTROL_ENV and FORK_DOMAIN_ROOT (injected into GitHubRepoWriter), PROMETHEUS_QUERY_URL, PROMETHEUS_READ_USERNAME, PROMETHEUS_READ_PASSWORD, ANALYTICS_QUERY_TIMEOUT_MS, EVM_RPC_URL
- **Files considered API:** Port implementation exports, database client, onchain client interfaces

## Ports (optional)

- **Uses ports:** none
- **Implements ports:** All ports defined in ports/
- **Contracts (required if implementing):** tests/contract/ must pass for all implementations

- Node-deploy Cloudflare DNS reads bound native zone identity through the existing adapter. Parsed mismatch/unavailable results refuse use; rotation revalidates through the same projected files. Identity reads prove no edit permission.

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
- **External:** drizzle-orm, postgres, langfuse, pino, siwe, viem, litellm, @grpc/grpc-js + @grpc/proto-loader (Headscale socket client)

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
