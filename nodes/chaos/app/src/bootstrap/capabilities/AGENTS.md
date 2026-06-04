# bootstrap/capabilities · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** stable

## Purpose

Capability factories bridging ai-tools interfaces to adapters. Creates environment-aware capability instances.

## Pointers

- [Tool Use Spec](../../../../../docs/spec/tool-use.md)
- [Tools Authoring](../../../../../docs/guides/tools-authoring.md)

## Boundaries

```json
{
  "layer": "bootstrap",
  "may_import": ["adapters/server", "adapters/test", "shared"],
  "must_not_import": ["app", "features", "core"]
}
```

## Public Surface

- **Exports:** `createMetricsCapability()`, `stubMetricsCapability`, `createRepoCapability()`, `stubRepoCapability`, `createWebSearchCapability()`
- **Env/Config keys:** PROMETHEUS_REMOTE_WRITE_URL, PROMETHEUS_QUERY_URL, PROMETHEUS_READ_USERNAME, PROMETHEUS_READ_PASSWORD, COGNI_REPO_PATH, COGNI_REPO_ROOT, TAVILY_API_KEY via ServerEnv
- **Files considered API:** `metrics.ts`, `repo.ts`, `web-search.ts`

## Responsibilities

- This directory **does**: Create capability instances, handle test/prod adapter selection
- This directory **does not**: Implement transport, execute tools

## Usage

```bash
# Consumed by container.ts automatically
```

## Standards

- Test mode returns fake adapter-backed capability
- Missing config returns stub that throws

## Dependencies

- **Internal:** adapters/server, adapters/test, shared
- **External:** `@cogni/ai-tools`

## Change Protocol

- Add new capability factory when adding tools requiring I/O

## Notes

- Pattern: test mode uses fake adapter, prod requires env vars or returns stub
