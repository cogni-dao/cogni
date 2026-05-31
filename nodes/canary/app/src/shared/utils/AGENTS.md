# shared/utils · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Pure utility functions shared across UI and feature layers. Domain-agnostic helpers for money formatting, validation, and other common operations.

## Pointers

- [Root AGENTS.md](../../../../../AGENTS.md)
- [Shared Layer Guide](../AGENTS.md)

## Boundaries

```json
{
  "layer": "shared",
  "may_import": ["types"],
  "must_not_import": [
    "app",
    "features",
    "core",
    "ports",
    "adapters",
    "bootstrap",
    "components"
  ]
}
```

## Public Surface

- **Exports:**
  - `money.ts`:
    - `parseDollarsToCents(input)` - String-to-cents conversion without float math
    - `formatCentsToDollars(cents)` - Cents-to-dollar string for display
    - `isValidAmountInput(input)` - Validates amount string while typing
    - `MIN_AMOUNT_USD`, `MAX_AMOUNT_USD` - Payment range constants

## Responsibilities

- This directory **does**: provide pure utility functions; parse/format money values using string manipulation (no floats); validate input patterns
- This directory **does not**: contain business logic; access external systems; depend on React or web3 libraries

## Usage

```typescript
import {
  parseDollarsToCents,
  formatCentsToDollars,
} from "@/shared/utils/money";

// Parse user input to cents (no float math)
const cents = parseDollarsToCents("10.50"); // → 1050
const display = formatCentsToDollars(1050); // → "10.50"
```

## Standards

- All functions are pure (no side effects)
- No floating-point arithmetic for money operations
- String-based parsing with explicit range validation
- Utilities must be framework-agnostic (usable in Node, browser, tests)

## Change Protocol

- Update when adding new utility modules
- Bump **Last reviewed** date
- Keep utilities small and focused

## Notes

- Money utilities prevent float precision errors in payment calculations
- All parsing uses string manipulation and parseInt for exact cent values
