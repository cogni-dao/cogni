# accounts · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Account error translation and billing safety helpers that map port-level errors into stable feature-level shapes for the app layer.

## Pointers

- [AccountService port](../../ports/accounts.port.ts)
- [Core accounts domain](../../core/accounts/)
- [Endpoint contracts](../../contracts/)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["features", "ports", "core", "shared", "types"],
  "must_not_import": [
    "app",
    "adapters/server",
    "adapters/worker",
    "bootstrap",
    "contracts"
  ]
}
```

## Public Surface

- **Exports:** AccountsFeatureError types and mapping helpers
- **Routes (if any):** none (consumed by app layer)
- **Files considered API:** errors.ts

## Ports (optional)

- **Uses ports:** AccountService
- **Implements ports:** none
- **Contracts (required if implementing):** none

## Responsibilities

- This directory **does**: Translate port errors to feature errors; provide stable error contracts for app layer
- This directory **does not**: Handle HTTP concerns, authenticate requests, persist data directly

## Usage

Minimal local commands:

```bash
pnpm test tests/unit/features/accounts/
pnpm typecheck
```

## Standards

- Error translation from port errors to AccountsFeatureError
- Unit tests with mocked ports required

## Dependencies

- **Internal:** ports/accounts, core/accounts, shared/util
- **External:** none

## Change Protocol

- Update this file when **Exports** or service signatures change
- Bump **Last reviewed** date
- Update dependent facades when Result types change
- Ensure boundary lint + unit tests pass

## Notes

- Feature services use Result pattern to avoid throwing across feature boundaries
- Error translation provides stable feature-level error contracts to app layer
