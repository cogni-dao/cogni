# financial-ledger · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Double-entry financial ledger capability package. Provides `FinancialLedgerPort` interface, well-known account/ledger constants, and `TigerBeetleAdapter` implementation. TigerBeetle enforces balanced transfers at the engine level.

## Pointers

- [Financial Ledger Spec](https://node-template.cognidao.org/knowledge/financial-ledger-tigerbeetle)
- [Packages Architecture](https://node-template.cognidao.org/knowledge/package-isolation-rules)

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

**External deps:** `tigerbeetle-node` (N-API addon, isolated via subpath export).

## Public Surface

- **`@cogni/financial-ledger`** (main barrel — port + domain, NO N-API):
  - `FinancialLedgerPort` — port interface
  - `TransferParams`, `LedgerAccount`, `AccountBalance` — port types
  - `FinancialLedgerError`, `TransferError`, `AccountNotFoundError` — error types
  - `ACCOUNT`, `LEDGER`, `ACCOUNT_CODE`, `TRANSFER_CODE` — constants
  - `ACCOUNT_DEFINITIONS` — account hierarchy for idempotent creation
  - `microUsdcToCredits()`, `uuidToBigInt()` — conversion utilities
- **`@cogni/financial-ledger/adapters`** (subpath — includes N-API):
  - `TigerBeetleAdapter` — implements FinancialLedgerPort via tigerbeetle-node

## Ports

- **Implements:** `FinancialLedgerPort` (via TigerBeetleAdapter)
- **Uses:** none

## Responsibilities

- This package **does**: Define the financial ledger contract, provide account constants, implement TigerBeetle adapter
- This package **does not**: Load env vars, manage process lifecycle, import from `src/`

## Usage

```bash
pnpm --filter @cogni/financial-ledger typecheck
pnpm --filter @cogni/financial-ledger test
```

## Standards

- Port + domain are pure (no I/O, no side effects)
- Adapter takes TB client as constructor arg (no env loading)
- All monetary math uses bigint (ALL_MATH_BIGINT)

## Dependencies

- **Internal:** none (standalone capability package)
- **External:** `tigerbeetle-node` (adapter only, isolated via subpath)

## Notes

- Main barrel (`@cogni/financial-ledger`) deliberately excludes N-API adapter — import `@cogni/financial-ledger/adapters` only where TigerBeetle is needed.
- Account hierarchy changes must sync with [Financial Ledger Spec](https://node-template.cognidao.org/knowledge/financial-ledger-tigerbeetle).

## Change Protocol

- Update this file when public exports or boundaries change.
