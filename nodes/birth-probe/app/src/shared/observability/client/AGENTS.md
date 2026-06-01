# client · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable

## Purpose

Client-side structured logging using browser console with EVENT_NAMES registry enforcement. No log shipping (MVP).

## Pointers

- [Parent AGENTS.md](../AGENTS.md)
- [Event Registry](../events/index.ts)

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
  - `debug(event, meta?)` - Dev-only console
  - `info(event, meta?)` - Dev-only console
  - `warn(event, meta?)` - Always-on console
  - `error(event, meta?)` - Always-on console
- **Env/Config keys:** `NODE_ENV`
- **Files considered API:** `index.ts`, `logger.ts`

## Ports

- **Uses ports:** none
- **Implements ports:** none
- **Contracts:** none

## Responsibilities

- This directory **does**: Provide browser-safe console logging; scrub forbidden keys; truncate large values; enforce EVENT_NAMES
- This directory **does not**: Ship logs to backend; use Node.js APIs; implement telemetry pipeline

## Usage

```typescript
import { clientLogger, EVENT_NAMES } from "@/shared/observability";

clientLogger.error(EVENT_NAMES.CLIENT_CHAT_STREAM_ERROR, {
  error: err.message,
});
```

## Standards

- Event names from EVENT_NAMES registry (EventName | string for migration period)
- Forbidden keys dropped: prompt, messages, apiKey, authorization, cookie
- Debug/info dev-only; warn/error always-on
- Safe serialization via fast-safe-stringify

## Dependencies

- **Internal:** `../events` (EventName)
- **External:** fast-safe-stringify

## Change Protocol

- Update logger.ts if scrubbing/truncation rules change
- Do not add log shipping without explicit approval

## Notes

- Logs to console only - not collected by Alloy/Loki (MVP)
- Accepts EventName | string during migration period
- Future: add telemetry pipeline for client errors in separate PR
