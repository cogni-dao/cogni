# context · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable

## Purpose

Request-scoped context with child logger, reqId, routeId, and structural Clock interface.

## Pointers

- [Parent AGENTS.md](../AGENTS.md)
- [Route wrapper](../../../bootstrap/http/wrapRouteHandlerWithLogging.ts)

## Boundaries

```json
{
  "layer": "shared",
  "may_import": ["shared"],
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
  - `RequestContext` - type with log, reqId, routeId, session
  - `Clock` - structural interface `{ now(): string }`
  - `createRequestContext(deps, request, opts)` - factory with reqId validation
- **Files considered API:** `index.ts`, `types.ts`, `factory.ts`

## Ports

- **Uses ports:** none (structural Clock only)
- **Implements ports:** none
- **Contracts:** none

## Responsibilities

- This directory **does**: Create request-scoped context; validate reqId (max 64 chars, alphanumeric + `_-`); enrich logger with request metadata
- This directory **does not**: Create loggers; define event schemas; depend on Container

## Usage

```typescript
import { createRequestContext } from "@/shared/observability";

const ctx = createRequestContext(
  { baseLog: container.log, clock: container.clock },
  request,
  { routeId: "ai.chat", session }
);

ctx.log.info({ reqId: ctx.reqId }, "Processing request");
```

## Standards

- reqId validation prevents log injection attacks
- Structural Clock interface prevents port dependency
- Session is optional (public routes)

## Dependencies

- **Internal:** `@/shared/auth` (SessionUser type)
- **External:** none

## Change Protocol

- Update types.ts if RequestContext shape changes
- Update factory.ts if reqId validation rules change
- Ensure parent AGENTS.md updated if public API changes

## Notes

- Decoupled from Container (takes `{ baseLog, clock }` not full container)
- Structural Clock prevents circular dependency on ports
