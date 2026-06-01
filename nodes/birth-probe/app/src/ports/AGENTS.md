# ports · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Define **port interfaces** that the domain depends on and adapters must implement.
Ports describe _what_ the domain needs from external services, not _how_ they work. Includes AccountService with dual-cost LLM billing support.

## Pointers

- [Root AGENTS.md](../../../../AGENTS.md)
- [Architecture](../../../../docs/spec/architecture.md)

## Boundaries

```json
{
  "layer": "ports",
  "may_import": ["ports", "core", "types"],
  "must_not_import": [
    "app",
    "features",
    "adapters/server",
    "adapters/worker",
    "shared"
  ]
}
```

## Public Surface

Two entrypoints enforce Next.js App Router environment boundaries (see bug.0147):

### `index.ts` — Client-safe barrel

Importable from any module (client components, server components, hooks, services).
Does NOT re-export packages with `node:` transitive dependencies.

- AccountService, ServiceAccountService, LlmService, AgentCatalogPort, AgentDescriptor
- GraphExecutorPort, PreflightCreditCheckFn, GraphRunRequest (with `modelRef: ModelRef`), GraphRunResult, GraphFinal (with optional `structuredOutput`)
- ModelProviderPort, ModelCatalogPort, ModelProviderResolverPort, ModelOption, ModelRef, ModelCapabilities
- ConnectionBrokerPort (with `ConnectionScope: { actorId, tenantId }`)
- LlmChargeDetail, ChatDeltaEvent, LlmError, LlmErrorKind, isLlmError
- PaymentAttemptUserRepository, PaymentAttemptServiceRepository, OnChainVerifier
- MetricsQueryPort, AiTelemetryPort, LangfusePort, Clock
- Port-level errors (InsufficientCreditsPortError, BillingAccountNotFoundPortError, etc.)
- SandboxRunnerPort, SandboxRunSpec, SandboxRunResult, SandboxProgramContract
- ThreadPersistencePort, ThreadConflictError, ThreadSummary
- OperatorWalletPort, TransferIntent
- ProviderFundingPort, ProviderFundingContext, ProviderFundingOutcome
- TreasurySettlementPort, TreasurySettlementOutcome
- Types (ChargeReceiptParams, LlmCaller, BillingAccount, CreditLedgerEntry, etc.)

### `server.ts` — Server-only barrel

Re-exports from `@cogni/scheduler-core` (transitively imports `node:util`).
MUST NOT be imported by client components, hooks, or client-reachable barrels.
Biome `noRestrictedImports` enforces this in `biome/app.json`.

- ScheduleControlPort, ScheduleUserPort, ScheduleWorkerPort
- ExecutionGrantUserPort, ExecutionGrantWorkerPort, ExecutionRequestPort
- ScheduleRunRepository
- Grant errors (GrantNotFoundError, GrantExpiredError, GrantRevokedError, GrantScopeMismatchError)
- Schedule errors (ScheduleNotFoundError, ScheduleAccessDeniedError, InvalidCronExpressionError, InvalidTimezoneError)

- **Env/Config:** none
- **Files considered API:** all \*.port.ts files, `index.ts`, `server.ts`

Note: src/ports/** is separate from src/contracts/**.
Ports = internal dependencies; contracts = edge IO (HTTP/MCP).

## Responsibilities

- This directory **does:** Define interfaces for external dependencies (DB, AI, wallet, clock, rng, queues, etc.); Document expectations and invariants for each port (e.g. idempotency, error semantics)
- This directory **does not:** Contain implementations or concrete dependencies; Contain business logic, HTTP handlers, or framework code; Import adapters, features, or delivery layers

## Usage

Each port must have port behavior tests in tests/ports/\*\*

Example: tests/ports/credits.port.spec.ts

Port tests verify that all adapters obey the port's interface and invariants

These tests are separate from edge tests for src/contracts/\*\*

## Standards

- Files are interface-only (interface, type), no classes or side effects
- Port filenames end with .port.ts (e.g. credits.port.ts, clock.port.ts)
- All time and randomness must go through ports (Clock, Rng) to keep domain deterministic

## Dependencies

- **Internal:** src/core
- **External:** none

## Change Protocol

- Update this file when Exports or boundaries change
- Bump Last reviewed date
- Ensure ESLint boundary rules still pass and all tests/ports/\*\* still pass

## Notes

- Port tests are located in tests/ports/\*\* to validate adapter conformance
- Ports define contracts for internal dependencies, separate from external API contracts
- PaymentAttemptUserRepository enforces ownership via RLS (withTenantScope) + billingAccountId filter; PaymentAttemptServiceRepository uses BYPASSRLS with billingAccountId defense-in-depth
- OnChainVerifier is generic (no blockchain-specific types), returns VerificationResult with status (VERIFIED | PENDING | FAILED)
- Port-level errors are thrown by adapters, caught and translated by feature layer
- recordChargeReceipt is non-blocking (never throws InsufficientCredits post-call per ACTIVITY_METRICS.md)
- Activity dashboard reads from charge_receipts + llm_charge_details (no external API dependency); LiteLLM usage service removed
