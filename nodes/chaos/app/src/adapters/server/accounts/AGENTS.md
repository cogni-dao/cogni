# accounts · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

PostgreSQL implementations of account service ports for credit accounting and charge receipt recording. Per CHARGE_RECEIPTS_IS_LEDGER_TRUTH, charge_receipts + llm_charge_details is the primary data source for Activity dashboard.

## Pointers

- [AccountService port](../../../ports/accounts.port.ts)
- [Database schema](../../../shared/db/schema.ts)

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["adapters/server", "ports", "shared", "types"],
  "must_not_import": ["app", "features", "core"]
}
```

## Public Surface

- **Exports:** UserDrizzleAccountService (RLS-enforced, user-scoped), ServiceDrizzleAccountService (BYPASSRLS, service-role)
- **Env/Config keys:** DATABASE_URL
- **Files considered API:** drizzle.adapter.ts

## Ports (optional)

- **Uses ports:** none
- **Implements ports:** AccountService (includes listLlmChargeDetails), ServiceAccountService
- **Contracts (required if implementing):** AccountService contract tests pending

## Responsibilities

- This directory **does**: Implement AccountService using PostgreSQL via Drizzle ORM; atomic recordChargeReceipt with optional llmDetail insert into llm_charge_details (idempotent, non-blocking); listLlmChargeDetails for Activity dashboard enrichment; virtual key provisioning via LiteLLM API
- This directory **does not**: Handle business logic or authentication; compute pricing (uses pre-calculated values from features layer)

## Usage

Minimal local commands:

```bash
pnpm test tests/component/
```

## Standards

- All credit operations must use database transactions
- Atomic operations prevent race conditions
- Transaction rollback on insufficient credits

## Dependencies

- **Internal:** ports, shared/db, shared/util
- **External:** drizzle-orm

## Change Protocol

- Update this file when **Exports** or **Env/Config** change
- Bump **Last reviewed** date
- Ensure boundary lint + contract tests pass

## Notes

- Implements ledger-based accounting with computed balance cache
- Transaction semantics critical for credit integrity
- recordChargeReceipt is idempotent (request_id as unique key) and non-blocking (never throws InsufficientCredits post-call)
- llm_charge_details stores model/tokens/provider/latency/graphId; 1:1 with charge_receipts via PK/FK cascade
- charge_receipts.receipt_kind distinguishes receipt types (e.g. "llm")
