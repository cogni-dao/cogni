# tests/unit/shared · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Unit tests for shared layer modules, ensuring validation and type safety across foundational utilities.

## Pointers

- [Root AGENTS.md](../../../../../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)
- [Tests AGENTS.md](../../../../../AGENTS.md)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["shared"],
  "must_not_import": []
}
```

## Public Surface

- **Exports:** none
- **CLI:** `pnpm test tests/unit/shared`

## Responsibilities

- This directory **does:** validate shared module contracts, test environment validation patterns, mock process.env for deterministic tests.
- This directory **does not:** test integration scenarios, define production code, or test cross-layer interactions.

## Usage

```bash
pnpm test tests/unit/shared
pnpm test tests/unit/shared/env.test.ts
```

## Standards

- Use vi.resetModules() for environment variable testing
- Clean process.env state between tests
- No I/O, external dependencies, or side effects

## Dependencies

- **Internal:** src/shared
- **External:** vitest

## Change Protocol

- Update tests when shared module APIs change
- Bump Last reviewed date
- Ensure boundary lint passes

## Notes

- Environment tests require module cache clearing due to import-time validation
