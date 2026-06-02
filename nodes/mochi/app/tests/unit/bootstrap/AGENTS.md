# tests/unit/bootstrap · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Unit tests for application bootstrapping and dependency injection container logic.

## Pointers

- [Bootstrap container](../../../src/bootstrap/container.ts)
- [Architecture](../../../../../docs/spec/architecture.md)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["bootstrap", "adapters/server", "adapters/test", "ports"],
  "must_not_import": []
}
```

## Public Surface

- **Exports:** none
- **CLI:** `pnpm test tests/unit/bootstrap`

## Responsibilities

- This directory **does:** Verify correct adapter selection based on `APP_ENV`, ensure singleton behavior of container, test DI wiring.
- This directory **does not:** Test the actual adapters or business logic.

## Usage

```bash
pnpm test tests/unit/bootstrap
```

## Standards

- Use `vi.resetModules()` to test environment-based import logic.
- Ensure clean environment state before/after tests.

## Dependencies

- **Internal:** src/bootstrap, src/adapters
- **External:** vitest

## Change Protocol

- Update tests when `APP_ENV` logic or container structure changes.
- Bump Last reviewed date.
- Ensure boundary lint passes.

## Notes

- Tests use dynamic imports to simulate app startup conditions.
