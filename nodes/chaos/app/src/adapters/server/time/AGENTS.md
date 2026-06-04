# time · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

System clock implementations for timestamp generation in production environments.

## Pointers

- [Clock port](../../../ports/clock.port.ts)
- [FakeClock test double](../../test/)

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["adapters/server", "ports", "shared", "types"],
  "must_not_import": ["app", "features", "core"]
}
```

## Public Surface

- **Exports:** SystemClock implementation
- **Files considered API:** system.adapter.ts

## Ports (optional)

- **Uses ports:** none
- **Implements ports:** Clock
- **Contracts (required if implementing):** Clock contract tests pending

## Responsibilities

- This directory **does**: Provide real system time access for production use
- This directory **does not**: Handle timezone conversion or date arithmetic

## Usage

Minimal local commands:

```bash
pnpm test tests/unit/
```

## Standards

- Returns ISO 8601 formatted timestamps
- No timezone manipulation (uses system timezone)
- Deterministic interface for testing with fakes

## Dependencies

- **Internal:** ports
- **External:** none (uses native Date API)

## Change Protocol

- Update this file when **Exports** change
- Bump **Last reviewed** date
- Ensure contract tests pass

## Notes

- Used in production for real timestamp generation
- Paired with FakeClock in tests for deterministic behavior
