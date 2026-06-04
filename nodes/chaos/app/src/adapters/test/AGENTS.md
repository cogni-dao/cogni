# test · AGENTS.md

> Scope: this directory only. ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Deterministic fake implementations of ports for CI and test environments. No external dependencies.

## Pointers

- [Root AGENTS.md](../../../../../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)
- [Testing Documentation](../../../../../docs/guides/testing.md)

## Boundaries

```json
{
  "layer": "adapters/test",
  "may_import": ["adapters/test", "ports", "shared", "types"],
  "must_not_import": ["app", "features", "core"]
}
```

## Public Surface

- **Exports:** FakeMetricsAdapter, FakeWebSearchAdapter, FakeRepoAdapter, FakeEvmOnchainClient, getTestEvmOnchainClient(), resetTestEvmOnchainClient(), FakeOnChainVerifierAdapter, getTestOnChainVerifier(), resetTestOnChainVerifier()
- **Env/Config keys:** none (deterministic responses only)
- **Files considered API:** index.ts barrel export, test helper functions for configuring fakes (singleton accessors)

## Responsibilities

- This directory **does**: Provide deterministic fake port implementations; expose singleton accessors for test configuration; enable CI testing without external dependencies
- This directory **does not**: Make external calls; persist state between test runs; contain production logic

## Usage

Used automatically when `APP_ENV=test` via bootstrap container.

```bash
# CI automatically uses fake adapters
APP_ENV=test pnpm test:component
```

## Standards

- All responses must be deterministic by default
- Configurable via singleton accessors for stack tests (getTestOnChainVerifier)
- Reset to defaults in test beforeEach/afterEach hooks
- No external dependencies or network calls
- Must implement same port interfaces as real adapters

## Dependencies

- **Internal:** ports/, shared/
- **External:** none

## Change Protocol

- Update this file when **Exports** or **Implementations** change
- Bump **Last reviewed** date
- Ensure contract tests pass for all fake implementations

## Notes

- Bootstrap layer injects via APP_ENV=test check in container
- Stack tests import singleton accessors directly to configure behavior
- Responses are deterministic by default but configurable for scenario testing
- Account testing uses mock fixtures in tests/\_fakes instead of adapter implementations
