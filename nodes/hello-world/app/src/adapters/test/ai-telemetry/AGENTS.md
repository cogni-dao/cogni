# adapters/test/ai-telemetry · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

In-memory test doubles for AI telemetry ports. Records invocations for test assertions without DB or external calls.

## Pointers

- [Root AGENTS.md](../../../../../../AGENTS.md)
- [Parent test adapters AGENTS.md](../AGENTS.md)
- [AI Setup](../../../../../../docs/spec/ai-setup.md)

## Boundaries

```json
{
  "layer": "adapters/test",
  "may_import": ["ports", "shared", "types"],
  "must_not_import": ["app", "features", "core", "contracts"]
}
```

## Public Surface

- **Exports:** FakeAiTelemetryAdapter (implements AiTelemetryPort)
- **Files considered API:** fake-ai-telemetry.adapter.ts

## Ports

- **Uses ports:** none
- **Implements ports:** AiTelemetryPort
- **Contracts:** tests/contract/ (port compliance)

## Responsibilities

- **This directory does:**
  - Provide in-memory AiTelemetryPort implementation for tests
  - Record invocations for assertion (invocations array)
  - Support reset() between tests
  - Provide query helpers (getByStatus, getLast)
- **This directory does not:**
  - Write to database
  - Make external calls
  - Persist state between test runs

## Usage

```typescript
const telemetry = new FakeAiTelemetryAdapter();
// ... run code under test ...
expect(telemetry.getLast()?.status).toBe("success");
telemetry.reset();
```

## Standards

- Deterministic behavior (no randomness)
- Reset in beforeEach/afterEach hooks
- Same interface as DrizzleAiTelemetryAdapter

## Dependencies

- **Internal:** @/ports (AiTelemetryPort, RecordInvocationParams)
- **External:** none

## Change Protocol

- Update this file when Exports change
- Bump Last reviewed date
- Ensure contract tests pass

## Notes

- Used by unit tests to verify telemetry recording without DB
- Bootstrap injects via APP_ENV=test check in container
