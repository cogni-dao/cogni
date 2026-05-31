# tests/external · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Tests that hit real internet services or 3rd-party APIs. These require secrets and are **not** part of default CI. Run nightly or on-demand.

## Pointers

- [Component tests](../component/) — isolated testcontainers, no server
- [Stack tests](../stack/) — full HTTP + DB tests
- [Vitest config](../../vitest.external.config.mts) — external test runner config

## Boundaries

```json
{
  "layer": "tests",
  "may_import": [
    "adapters/server",
    "ports",
    "shared",
    "tests",
    "services",
    "packages"
  ],
  "must_not_import": ["core", "features", "app", "mcp"]
}
```

## Public Surface

- **Exports:** none
- **CLI:** `pnpm test:external`
- **Env/Config keys:** `GITHUB_TOKEN` or `GH_TOKEN` (GitHub API access)

## Responsibilities

- This directory **does:** test adapters against real external services (APIs, blockchains, 3rd-party providers)
- This directory **does not:** test local-infra adapters (use component/), test full stack (use stack/)

## Usage

```bash
# Requires GITHUB_TOKEN or GH_TOKEN in environment
# Also spins up testcontainers PostgreSQL for ledger round-trip tests
pnpm test:external

# Skips gracefully if no token is set
```

## Standards

- Tests must be idempotent and safe to run repeatedly
- Use dedicated test accounts / API keys (never production credentials)
- Expect network latency; use generous timeouts (30s per test)
- Skip entire suite if required tokens are missing (no failures in CI without secrets)
- Assert minimums and known fixtures, not exact counts (test repos may gain data over time)

## Dependencies

- **Internal:** src/adapters, src/ports, src/shared, services/scheduler-worker, packages/\*
- **External:** vitest, testcontainers (PostgreSQL), real API keys / secrets

## Test Repos

- **Cogni-DAO/test-repo** — GitHub adapter validation target. Contains known merged PRs, closed issues, and reviews.

## Change Protocol

- Add tests here when new external adapter implementations exist
- Bump **Last reviewed** date

## Notes

- **NOT** in default CI pipeline (unit → component → system)
- Run as nightly / on-demand workflow with secrets injection
- Failures here do not block PRs
