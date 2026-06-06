# observability · AGENTS.md

> Scope: this directory only. Keep ≤150 lines.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable

## Purpose

Cross-cutting observability concerns: structured logging, request context, and event schemas for correlation across HTTP routes and features.

## Pointers

- [Observability](../../../../../docs/spec/observability.md) - Observability system documentation
- [Event Registry](events/index.ts) - EVENT_NAMES as const (single source of truth)
- [Server Logger](server/logger.ts) - Pino factory with sync mode
- [Client Logger](client/logger.ts) - Browser console logger with event registry
- [RequestContext](context/types.ts) - Request-scoped context type

## Boundaries

```json
{
  "layer": "shared",
  "may_import": ["shared"],
  "must_not_import": ["ports", "bootstrap", "core", "features", "adapters"]
}
```

## Public Surface

- **Exports:**
  - `EVENT_NAMES` - Event name registry as const (prevents ad-hoc strings)
  - `EventName`, `EventBase` - Registry-derived types
  - `makeLogger(bindings?)` - Pino logger factory (sync mode, zero buffering)
  - `makeNoopLogger()` - Silent logger for tests
  - `logEvent(logger, eventName, fields, message?)` - Type-safe event logger (enforces reqId)
  - `clientLogger.debug/info/warn/error(event, meta?)` - Client-side console logger (no shipping)
  - `createRequestContext({ baseLog, clock }, request, { routeId, session })` - Request context factory
  - `logRequestStart/End/Error/Warn(log, ...)` - Request lifecycle helpers
  - `Logger`, `RequestContext`, `Clock` - Types
  - `AiLlmCallEvent`, `PaymentsConfirmedEvent`, etc. - Strict payload types (optional)
- **Env/Config keys:** `PINO_LOG_LEVEL`, `NODE_ENV`, `SERVICE_NAME`, `VITEST`
- **Files considered API:** `index.ts`, `events/index.ts`, `server/index.ts`, `client/index.ts`

## Ports

- **Uses ports:** none (structural Clock interface only)
- **Implements ports:** none
- **Contracts:** none

## Responsibilities

- This directory **does**:
  - Provide EVENT_NAMES registry (prevents ad-hoc event strings and schema drift)
  - Provide logEvent() wrapper (enforces reqId presence, throws in CI/tests only)
  - Provide Pino logger factory (sync mode, zero buffering, JSON stdout)
  - Provide clientLogger for browser console (uses EVENT_NAMES, no shipping)
  - Define RequestContext for request-scoped logging
  - Provide request lifecycle helpers (logRequestStart/End/Error/Warn)
  - Define strict payload types for high-value events (AiLlmCallEvent, PaymentsEvent)
  - Validate reqId from header (max 64 chars, alphanumeric + `_-`)
  - Redact sensitive fields (tokens, headers, keys, prompts)

- This directory **does not**:
  - Depend on Container or port interfaces
  - Implement log collection or shipping
  - Define domain business logic
  - Handle HTTP routing

## Usage

**Server route handler:**

```typescript
import { getContainer } from "@/bootstrap/container";
import {
  createRequestContext,
  logRequestStart,
  logRequestEnd,
} from "@/shared/observability";

const container = getContainer();
const ctx = createRequestContext(
  { baseLog: container.log, clock: container.clock },
  request,
  { routeId: "ai.completion", session }
);

logRequestStart(ctx.log);
```

**Server feature service:**

```typescript
import { EVENT_NAMES, type AiLlmCallEvent } from "@/shared/observability";

export async function execute(..., ctx: RequestContext) {
  const log = ctx.log.child({ feature: "ai.completion" });
  const llmEvent: AiLlmCallEvent = {
    event: "ai.llm_call",
    routeId: ctx.routeId,
    reqId: ctx.reqId,
    billingAccountId: caller.billingAccountId,
    model,
    durationMs,
    tokensUsed,
  };
  log.info(llmEvent, EVENT_NAMES.AI_LLM_CALL_COMPLETED);
}
```

**Client component:**

```typescript
import { clientLogger, EVENT_NAMES } from "@/shared/observability";

export function MyComponent() {
  const handleError = (error: Error) => {
    clientLogger.error(EVENT_NAMES.CLIENT_CHAT_STREAM_ERROR, {
      error: error.message,
    });
  };
}
```

## Standards

- **Event registry enforcement:** All event names in EVENT_NAMES (no inline strings)
- **Sync logging:** `pino.destination({ sync: true, minLength: 0 })` prevents buffering under SSE
- **Fail-closed reqId:** logEvent() throws if reqId missing (VITEST=true only; logs error elsewhere)
- All console.\* prohibited in src/ - use Pino (server) or clientLogger (browser)
- Server: JSON-only to stdout; optional formatting via `pnpm dev:pretty`
- Client: debug/info dev-only; warn/error always; drops forbidden keys
- Security: reqId validation (max 64 chars, alphanumeric + `_-`); redaction paths
- Test silence: VITEST=true or NODE_ENV=test

## Dependencies

- **Internal:** `@/shared/auth` (SessionUser), `@/shared/env` (serverEnv)
- **External:** pino, pino-pretty (dev), fast-safe-stringify (client)

## Change Protocol

- Update this file when exports, event schemas, or boundaries change
- Update docs/spec/observability.md for architecture changes
- Ensure arch:check passes after boundary changes

## Notes

- Structural Clock interface `{ now(): string }` - ports/Clock satisfies this
- RequestContext decoupled from Container (takes `{ baseLog, clock }` only)
- V2 implementation: Alloy + local Loki (dev) + Grafana Cloud (preview/prod)
- Logging architecture: JSON stdout → Alloy → Loki (env label from DEPLOY_ENVIRONMENT)
