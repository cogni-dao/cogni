# sandbox · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Sandbox adapter for AI agent execution via **ephemeral** containers (`network=none`, CLI invocation via dockerode). LLM calls route through a dynamically-spawned nginx proxy to LiteLLM. Implements `SandboxRunnerPort`, `GraphExecutorPort`, `AgentCatalogProvider`.

## Pointers

- [Sandbox Spec](../../../../../../docs/spec/sandboxed-agents.md)
- [Sandbox Runtime](../../../../../../services/sandbox-runtime/)
- [Port Definition](../../../ports/sandbox-runner.port.ts)

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["ports", "shared", "types"],
  "must_not_import": ["app", "features", "core", "contracts"]
}
```

## Public Surface

- **Exports:** `SandboxRunnerAdapter`, `SandboxRunnerAdapterOptions`, `LlmProxyManager`, `LlmProxyConfig`, `LlmProxyHandle`, `ProxyStopResult`, `SandboxGraphProvider`, `SANDBOX_PROVIDER_ID`, `SandboxAgentCatalogProvider`
- **Env/Config keys:** litellmMasterKey via constructor; image per-run via SandboxRunSpec
- **Files considered API:** index.ts barrel export (not re-exported from parent server barrel — consumers use subpath imports to avoid Turbopack bundling dockerode native addon chain)

## Ports

- **Uses ports:** none (SandboxGraphProvider uses SandboxRunnerPort internally)
- **Implements ports:** `SandboxRunnerPort` (adapter), `GraphExecutorPort` (sandbox-graph.provider), `AgentCatalogProvider` (sandbox-agent-catalog.provider)
- **Contracts:** tests/component/sandbox/, tests/stack/sandbox/

## Responsibilities

- This directory **does**: Create ephemeral Docker containers (network=none); manage LLM proxy containers (nginx:alpine); share socket via Docker volume at `/llm-sock`; mount named Docker volumes; inject billing headers (proxy overwrites); collect stdout/stderr; handle timeouts and OOM; cleanup containers; route `sandbox:*` graphIds through the graph execution pipeline; list sandbox agents in the UI catalog.
- This directory **does not**: Implement agent logic (agent runs inside container); pass credentials to sandbox containers.

## Usage

```typescript
import { SandboxRunnerAdapter } from "@/adapters/server/sandbox";

const runner = new SandboxRunnerAdapter({
  litellmMasterKey: process.env.LITELLM_MASTER_KEY,
});
const result = await runner.runOnce({
  runId: "task-123",
  workspacePath: "/tmp/workspace",
  image: "cogni-sandbox-runtime:latest",
  argv: ["echo hello"],
  limits: { maxRuntimeSec: 30, maxMemoryMb: 256 },
  llmProxy: { enabled: true, billingAccountId: "acct-1", attempt: 0 },
});
await runner.dispose(); // stop all proxy containers
```

## Standards

- Ephemeral containers are one-shot, `network=none`, destroyed after run
- All capabilities dropped (`CapDrop: ['ALL']`), non-root user (`sandboxer`)
- Socket sharing via Docker volumes (not bind mounts) to avoid macOS osxfs issues and tmpfs masking
- All dockerode exec streams have bounded timeouts (never await unbounded `stream.on('end')`)
- Proxy containers labeled `cogni.role=llm-proxy` for sweep-based cleanup

## Dependencies

- **Internal:** ports/, shared/observability/
- **External:** dockerode, nginx:alpine image

## Change Protocol

- Update this file when **Exports** or **Port implementations** change
- Bump **Last reviewed** date
- Ensure integration and stack tests pass

## Notes

- Requires `cogni-sandbox-runtime:latest` image built from services/sandbox-runtime/
- Requires `nginx:alpine` image for proxy containers
- `LlmProxyManager.cleanupSweep()` removes orphaned proxy containers by label filter
