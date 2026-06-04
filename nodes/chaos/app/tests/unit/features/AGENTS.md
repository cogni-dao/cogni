# tests/unit/features · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Unit tests for use cases that orchestrate business logic via mocked ports.

## Pointers

- [Features source](../../../src/features/)
- [Test fakes](../../_fakes/)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["features", "core", "ports", "tests"],
  "must_not_import": ["adapters/server", "adapters/worker", "app"]
}
```

## Public Surface

- **Exports:** none
- **CLI:** `pnpm test tests/unit/features`

## Responsibilities

- This directory **does:** test use case logic with mocked port dependencies
- This directory **does not:** test real adapters or UI interactions

## Usage

```bash
pnpm test tests/unit/features
pnpm test tests/unit/features/use-cases.test.ts
```

## Standards

- Mock all port dependencies using test fakes
- No I/O, no time, no RNG
- Use dependency injection for testability

## Dependencies

- **Internal:** src/features, src/core, src/ports, tests/\_fakes
- **External:** vitest

## Change Protocol

- Update tests when use case logic changes
- Bump **Last reviewed** date
- Ensure boundary lint passes

## Notes

- Focus on testing use case orchestration logic
- Mock all external dependencies via ports
