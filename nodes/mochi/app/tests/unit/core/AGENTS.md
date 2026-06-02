# tests/unit/core · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Unit tests for pure domain logic with no external dependencies.

## Pointers

- [Root AGENTS.md](../../../../../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["core"],
  "must_not_import": [
    "ports",
    "adapters/server",
    "adapters/worker",
    "features",
    "app"
  ]
}
```

## Public Surface

- **Exports:** none
- **CLI:** `pnpm test tests/unit/core`

## Responsibilities

- This directory **does:** test pure domain entities, rules, and business invariants
- This directory **does not:** test I/O, external services, or cross-layer interactions

## Usage

```bash
pnpm test tests/unit/core
pnpm test tests/unit/core/entities.test.ts
```

## Standards

- No I/O, no time, no RNG
- Test pure functions and business rules only
- Use deterministic inputs and expected outputs

## Dependencies

- **Internal:** src/core
- **External:** vitest

## Change Protocol

- Update tests when core domain logic changes
- Bump **Last reviewed** date
- Ensure boundary lint passes

## Notes

- Focus on testing business invariants and domain rules
- Keep tests isolated from infrastructure concerns
