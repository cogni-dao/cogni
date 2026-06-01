# tests/\_fixtures/sandbox · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Shared test fixtures for sandbox container tests (P0, P0.5, P0.5a) and gateway acceptance tests. Provides runner helpers, container exec helpers, context setup, prerequisite assertions, and common test defaults.

## Pointers

- [Sandbox Adapter](../../../src/adapters/server/sandbox/)
- [Component Tests](../../component/docker/)
- [Stack Tests](../../stack/sandbox/)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["adapters/server", "ports", "shared"],
  "must_not_import": ["core", "features", "app", "mcp"]
}
```

## Public Surface

- **Exports:** `SANDBOX_IMAGE`, `DEFAULT_LIMITS`, `LLM_ROUNDTRIP_LIMITS`, `SANDBOX_TEST_MODELS`, `SandboxTestContext`, `SandboxTestContextWithProxy`, `uniqueRunId()`, `assertSandboxImageExists()`, `assertInternalNetworkExists()`, `ensureProxyImage()`, `assertLitellmReachable()`, `createWorkspace()`, `cleanupWorkspace()`, `cleanupOrphanedProxies()`, `execInContainer()`, `runWithProxy()`, `runIsolated()`, `runOnInternalNetwork()`, `runAgentWithLlm()`, `TEST_BILLING_ACCOUNT_ID`
- **Files considered API:** fixtures.ts

## Responsibilities

- This directory **does**: Provide `runWithProxy()` / `runIsolated()` / `runOnInternalNetwork()` / `runAgentWithLlm()` helpers; provide `execInContainer()` for docker exec against running compose services; manage temp workspace creation/cleanup; assert Docker prerequisites (image, network, LiteLLM); clean orphaned proxy containers via label filter; define shared test constants (limits, billing account ID, test models)
- This directory **does not**: Contain test assertions or test logic; manage container lifecycle directly

## Usage

```typescript
import {
  runWithProxy,
  runIsolated,
  createWorkspace,
  cleanupWorkspace,
} from "../../_fixtures/sandbox/fixtures";
```

## Standards

- `DEFAULT_LIMITS.maxRuntimeSec: 3` — tight timeout, fail fast
- `DEFAULT_LIMITS.maxMemoryMb: 128` — sufficient for curl/socat workloads

## Dependencies

- **Internal:** src/adapters/server/sandbox, src/ports
- **External:** dockerode, node:fs, node:os

## Change Protocol

- Update this file when exported helpers or default constants change
- Bump **Last reviewed** date

## Notes

- Imported by both component tests (tests/component/docker/) and stack tests (tests/stack/sandbox/)
