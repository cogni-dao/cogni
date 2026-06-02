# tests/component/docker · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Component tests for sandbox container execution via Docker. Proves network isolation, mount behavior, and lifecycle semantics using real Docker containers.

## Pointers

- [Sandbox Adapter](../../../src/adapters/server/sandbox/)
- [Sandbox Spec](../../../../../docs/spec/sandboxed-agents.md)
- [Parent Component Tests](../)

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
- **CLI:** `pnpm test tests/component/docker`
- **Env/Config keys:** `CI` (controls hard failure vs skip on missing image)

## Responsibilities

- This directory **does**: Test network=none enforcement; test workspace rw mounts; test repo ro mounts; test stdout/stderr capture; test exit codes; test timeouts; test OOM detection
- This directory **does not**: Test LLM integration; test domain logic; test HTTP boundaries

## Usage

```bash
# Build sandbox image first
docker build -t cogni-sandbox-runtime:latest services/sandbox-runtime

# Run tests
pnpm test tests/component/docker
```

## Standards

- Tests require `cogni-sandbox-runtime:latest` image
- In CI, missing image causes hard failure
- Locally, missing image causes skip with warning
- Tests run in parallel via Vitest
- Cleanup handled by adapter's finally block

## Dependencies

- **Internal:** src/adapters/server/sandbox, fixtures/
- **External:** vitest, dockerode, Docker daemon

## Change Protocol

- Update tests when sandbox adapter behavior changes
- Bump **Last reviewed** date
- Ensure all tests pass before merge

## Notes

- `tests/_fixtures/sandbox/fixtures.ts` provides shared test setup
- Access fixture via `fixture.runner`, not destructuring (beforeAll timing)
- Repo mount tests use `GITHUB_WORKSPACE ?? process.cwd()` for CI compatibility
