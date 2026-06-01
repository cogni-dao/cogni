# tests/stack/sandbox · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Stack tests for sandbox P0.5, P0.5a, and OpenClaw gateway. Proves socket bridge, proxy forwarding, network isolation, secrets safety, billing header injection, full LLM round-trip (via mock-openai-api), gateway repo mount (read-only volume, workspace writability), and pnpm store smoke (offline install from seeded store) using real Docker containers against a live dev stack.

## Pointers

- [Sandbox Spec](../../../../../docs/spec/sandboxed-agents.md)
- [Sandbox Adapter](../../../src/adapters/server/sandbox/)
- [Shared Fixtures](../../_fixtures/sandbox/fixtures.ts)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["adapters/server", "ports", "shared", "tests"],
  "must_not_import": ["core", "features", "app", "mcp"]
}
```

## Public Surface

- **Exports:** none
- **CLI:** `pnpm test:stack:dev -- sandbox-llm`, `pnpm test:stack:dev -- sandbox-repo-volume`, `pnpm test:stack:docker -- sandbox-openclaw`
- **Env/Config keys:** `LITELLM_MASTER_KEY` (required; tests skip if absent)

## Responsibilities

- This directory **does**: Test proxy health endpoint via socket bridge; test LiteLLM forwarding; test network isolation (no proxy → no connectivity); test secrets isolation (no LITELLM_MASTER_KEY in container env); test OPENAI_API_BASE injection; test spoofed header handling; test full LLM round-trip via mock-openai-api (response content, litellmCallId header chain); test repo volume mount (repo_data read-only at /repo); test OpenClaw gateway WS agent call; test gateway repo mount read-only + workspace writable; test callback-driven billing E2E (skipped; requires mock-llm compat fix bug.0009)
- This directory **does not**: Test ephemeral sandbox billing; test graph execution pipeline; test reconciliation

## Usage

```bash
# Requires running dev stack
pnpm dev:stack:test

# Run P0.5 proxy tests
pnpm test:stack:dev -- sandbox-llm
```

## Standards

- `testTimeout: 4_000` — full proxy+sandbox flow completes in <1s
- `hookTimeout: 10_000` — setup/teardown touches multiple containers
- Tests skip (not fail) if `LITELLM_MASTER_KEY` is unset
- `cleanupOrphanedProxies()` runs in beforeAll and afterAll

## Dependencies

- **Internal:** src/adapters/server/sandbox, tests/\_fixtures/sandbox
- **External:** vitest, dockerode, Docker daemon, LiteLLM, sandbox-internal network

## Change Protocol

- Update tests when proxy or sandbox adapter behavior changes
- Bump **Last reviewed** date
- Ensure `pnpm test:stack:dev -- sandbox-llm` passes

## Notes

- Requires `cogni-sandbox-runtime:latest` image — `pnpm sandbox:docker:build`
- Requires `cogni-sandbox-openclaw:latest` image — `pnpm sandbox:openclaw:docker:build` (or pulled from GHCR)
- Requires seeded `pnpm_store` volume — `pnpm sandbox:pnpm-store:seed` (for pnpm smoke tests)
- Requires `nginx:alpine` image for proxy containers
- Requires dev stack running — `pnpm dev:stack:test`
- Orphan proxy containers (label `cogni.role=llm-proxy`) cleaned up automatically
