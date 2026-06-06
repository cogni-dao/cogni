# server · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable

## Purpose

Server-side logging and metrics utilities. Pino logging with sync mode; Prometheus metrics via prom-client.

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
  - `makeLogger(bindings?)` - Pino factory
  - `makeNoopLogger()` - Silent logger for tests
  - `logEvent(logger, eventName, fields, message?)` - Type-safe event logger
  - `logRequestStart/End/Error/Warn` - Request lifecycle helpers
  - `REDACT_PATHS` - Sensitive field redaction
  - `Logger` - Pino type
  - `metricsRegistry` - prom-client Registry singleton (globalThis-backed)
  - `httpRequestsTotal`, `httpRequestDurationMs` - HTTP metrics
  - `aiChatStreamDurationMs`, `aiLlmCallDurationMs`, `aiLlmTokensTotal`, `aiLlmCostUsdTotal`, `aiLlmErrorsTotal` - AI metrics
  - `appBuildInfo` - Build info Gauge (`version`, `commit_sha` labels)
  - `setBuildInfo(version, commitSha)` - Set build info at runtime
  - `statusBucket(status)`, `classifyLlmError(error)` - Metric helpers
  - `LlmErrorCode` - Error code type
- **Env/Config keys:** `PINO_LOG_LEVEL`, `NODE_ENV`, `SERVICE_NAME`, `VITEST`, `APP_BUILD_SHA`
- **Files considered API:** `index.ts`, `logger.ts`, `logEvent.ts`, `helpers.ts`, `metrics.ts`

## Ports

- **Uses ports:** none
- **Implements ports:** none
- **Contracts:** none

## Responsibilities

- This directory **does**: Create Pino loggers; enforce reqId via logEvent(); emit JSON to stdout; redact sensitive fields
- This directory **does not**: Define event names; implement log collection; depend on Container

## Usage

```typescript
import { makeLogger, logEvent, EVENT_NAMES } from "@/shared/observability";

const logger = makeLogger({ component: "MyAdapter" });
logEvent(logger, EVENT_NAMES.ADAPTER_LITELLM_STREAM_RESULT, {
  reqId: "abc-123",
  model: "gpt-5",
  tokensUsed: 255,
});
```

## Standards

- Sync mode: `pino.destination({ sync: true, minLength: 0 })` prevents buffering
- Fail-closed reqId: logEvent() throws in tests (VITEST=true), logs error elsewhere
- No worker transports - JSON stdout only

## Dependencies

- **Internal:** `../events` (EVENT_NAMES, EventName, EventBase)
- **External:** pino, prom-client

## Change Protocol

- Update helpers.ts if request lifecycle patterns change
- Update logger.ts if Pino config changes
- Keep logEvent.ts minimal

## Notes

- Sync mode prevents buffered/delayed logs under SSE streaming
- Test silence: VITEST=true or NODE_ENV=test
