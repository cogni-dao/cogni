# events · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable

## Purpose

Event name registry as single source of truth. Prevents ad-hoc event strings and schema drift.

## Pointers

- [Parent AGENTS.md](../AGENTS.md)
- [Observability](../../../../../../docs/spec/observability.md)

## Boundaries

```json
{
  "layer": "shared",
  "may_import": ["types"],
  "must_not_import": [
    "app",
    "ports",
    "bootstrap",
    "core",
    "features",
    "adapters"
  ]
}
```

## Public Surface

- **Exports:**
  - `EVENT_NAMES` - as const registry with all valid event names
  - `EventName` - union type derived from EVENT_NAMES
  - `EventBase` - required base fields (reqId always; routeId for HTTP)
  - `AiActivityQueryCompletedEvent` - typed event with fetchedLogCount/unjoinedLogCount
  - `AiBillingCommitCompleteEvent` - billing commit outcome (success/error with chargedCredits or errorCode)
  - `AiRelayPumpErrorEvent` - relay pump failure event (per BILLING_INDEPENDENT_OF_CLIENT)
- **Files considered API:** `index.ts`, `ai.ts`, `payments.ts`

## Ports

- **Uses ports:** none
- **Implements ports:** none
- **Contracts:** none

## Responsibilities

- This directory **does**: Define all valid event names; provide EventName type; define EventBase for logEvent() enforcement
- This directory **does not**: Implement logging logic; create loggers; define domain business logic

## Usage

```typescript
import { EVENT_NAMES, type EventName } from "@/shared/observability";

// Use registry constants
log.info(
  { event: EVENT_NAMES.AI_CHAT_RECEIVED, reqId, userId },
  "Chat request received"
);
```

## Standards

- All new event names MUST be added to EVENT_NAMES registry
- Naming: server `domain.operation`, client `client.domain.operation`, invariants `inv_*`
- Only create strict payload types for events requiring cross-feature consistency

## Change Protocol

- Update EVENT_NAMES when adding new log events anywhere in codebase
- Update strict payload types (ai.ts/payments.ts) only for critical events
- Ensure parent AGENTS.md updated if structure changes

## Notes

- Type-only module with no runtime code
- Registry prevents schema drift by making event names explicit
