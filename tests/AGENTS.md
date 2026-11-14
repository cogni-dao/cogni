# tests · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Provide fast, reliable verification per layer. Enforce port contracts so any adapter is swappable without changing domain logic.

## Pointers

- [Root AGENTS.md](../AGENTS.md)
- [Architecture](https://node-template.cognidao.org/knowledge/hexagonal-layering-contract)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["*"],
  "must_not_import": []
}
```

## Public Surface

- **Exports:** none
- **CLI:** pnpm test, pnpm test:component
- **Files considered API:** contract/ports/\*_/_.contract.ts (test-only API for adapters)

## Ports (optional)

- **Uses ports:** all unit tests mock ports
- **Implements ports:** none
- **Contracts:** suites in tests/contract/ports/\*.contract.ts. Every adapter test must import and pass its suite.

## Responsibilities

- This directory **does:** unit tests for core/features, contract suites for ports, component tests for adapters, API integration tests for HTTP routes.
- This directory **does not:** run UI/e2e, define production code.

## Usage

```bash
pnpm test       # unit + ports tests (no server required)
pnpm test:component   # Component tests (isolated testcontainers, no server)
pnpm test:stack # Stack tests (requires running Next.js server + DB)
```

## Standards

- **Unit:** no I/O, no time, no RNG. Use \_fakes.
- **Contract:** define expected behavior once per port; adapters run the same suite.
- **Component:** real infra where feasible; clean setup/teardown in each spec.
- **API:** HTTP tests against running Next.js server; validate contract compliance and status codes.

## Dependencies

- **Internal:** src/core, src/features, src/ports, src/adapters, src/shared
- **External:** vitest, ts-node/tsconfig support, any local stubs needed for adapters

## Change Protocol

When port behavior changes, update the matching \*.contract.ts suite and adapters' component specs.
Bump Last reviewed date and ensure boundary lint passes.

## Notes

- Keep \_fakes minimal and deterministic.
- Prefer contract-first when adding a new adapter
