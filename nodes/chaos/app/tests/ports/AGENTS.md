# tests/ports · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Port behavior tests that verify implementations are swappable and conform to expected behavior.

## Pointers

- [Ports source](../../src/ports/)
- [Test harness](./harness/)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["ports", "core"],
  "must_not_import": ["adapters/server", "adapters/worker", "features", "app"]
}
```

## Public Surface

- **Exports:** test functions for port validation
- **CLI:** imported by component tests
- **Files considered API:** `harness/*.port.harness.ts`, `*.adapter.spec.ts`

## Responsibilities

- This directory **does:** define expected behavior for port implementations via harness contracts; test adapter compliance
- This directory **does not:** test business logic or internal adapter implementation details

## Usage

```bash
pnpm test tests/ports
pnpm test tests/ports/wallet.viem.adapter.spec.ts
```

## Standards

- Every port must have a harness contract in harness/ directory
- Adapter specs register with harness contracts to ensure compliance
- Port tests verify adapter implementations match expected behavior

## Dependencies

- **Internal:** src/ports, src/core
- **External:** vitest

## Change Protocol

- Update port tests when port interfaces change
- Bump **Last reviewed** date
- Ensure all adapters pass updated test suites

## Notes

- Harness contracts define the specification for implementations; adapters must pass
- Test harnesses provide shared infrastructure and cleanup utilities
