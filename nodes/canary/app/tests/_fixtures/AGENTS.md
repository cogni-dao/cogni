# tests/\_fixtures · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Static test data for consistent test scenarios across unit and component tests.

## Pointers

- [Unit tests](../unit/)
- [Component tests](../component/)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["shared"],
  "must_not_import": ["adapters", "core", "features", "app", "ports"]
}
```

## Public Surface

- **Exports:** JSON data files, auth helpers (db-helpers.ts, nextauth-http-helpers.ts, siwe-helpers.ts), wallet test data (test-data.ts), wallet HTTP helpers (api-helpers.ts), DB type utilities (db-utils.ts), DB seed client (db/seed-client.ts — getSeedDb for BYPASSRLS test seeding), AI fixtures (ai/models.response.json, ai/fixtures.ts, ai/mock-localstorage.ts), env fixtures (env/base-env.ts with CORE_TEST_ENV, BASE_VALID_ENV, PRODUCTION_VALID_ENV, MOCK_SERVER_ENV), scheduling fixtures (scheduling/db-helpers.ts, scheduling/fixtures.ts), Temporal client utilities (temporal/client.ts), ledger fixtures (ledger/seed-ledger.ts — TEST_NODE_ID, factory functions, seedClosedEpoch composite seeder)
- **Files considered API:** all .json files, auth/\*.ts, wallet/\*.ts, db-utils.ts, ai/\*.ts, env/\*.ts, scheduling/\*.ts, temporal/\*.ts, sandbox/\*.json

## Responsibilities

- This directory **does:** provide consistent test data for reproducible tests
- This directory **does not:** contain logic or executable code

## Usage

```bash
# Import test data in tests
import proposals from "@tests/_fixtures/proposals.json"
```

## Standards

- Prefer JSON for static data
- TypeScript helpers allowed for DRY test utilities (api-helpers, test constants)
- Keep data realistic but minimal
- No business logic in fixtures
- Never hard-code wallet addresses: use `generateTestWallet()` from auth/db-helpers.ts
- DB values: use `asNumber()` from db-utils.ts for BigInt → number conversions in assertions (safe for values < 2^53)

## Change Protocol

- Update this file when **Exports**, **Routes**, or **Env/Config** change
- Bump **Last reviewed** date

## Notes

- Whenever creating a fixture, first grab real data and directly model after it
