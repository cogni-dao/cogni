# features/ai/chat/utils · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable
- **Parent:** [features/ai/chat](../AGENTS.md)

## Purpose

Utilities for chat error mapping and UI presentation logic.

## Pointers

- [Parent: AI Chat Feature](../AGENTS.md)
- [Error Handling Architecture](../../../../../../../docs/spec/error-handling.md)
- [Chat Error Contract](../../../../contracts/error.chat.v1.contract.ts)

## Boundaries

```json
{
  "layer": "features",
  "may_import": ["contracts", "core", "ports", "shared", "types"],
  "must_not_import": ["app", "adapters", "components"]
}
```

## Public Surface

- **Exports (via ../public.ts):** mapHttpError, toErrorAlertProps
- **Files considered API:** mapHttpError.ts, toErrorAlertProps.ts

## Responsibilities

- **This directory does:** Map HTTP errors to ChatError contracts and transform ChatError to UI component props
- **This directory does not:** Implement HTTP clients, UI components, or retry logic

## Usage

```typescript
import { mapHttpError, toErrorAlertProps } from "@/features/ai/public";

// Map HTTP response to ChatError contract
const chatError = mapHttpError(response.status, await response.json());

// Transform ChatError to ErrorAlert props
const alertProps = toErrorAlertProps(chatError, hasFreeModel);
```

## Standards

- Pure functions (no side effects)
- Contract-based (all types from contracts/)
- Presenter pattern (ChatError → UI props)
- Export through parent public.ts

## Dependencies

- **Internal:** @/contracts/error.chat.v1.contract
- **External:** none

## Change Protocol

- Update parent public.ts when adding exports
- Contract changes flow: update contract → fix type errors
- Keep utilities pure (no IO, no state)

## Notes

- mapHttpError handles 402, 409, 429, 5xx, network errors
- toErrorAlertProps is a presenter (domain → UI props)
- Both functions are feature-layer utilities (not shared, not core)
