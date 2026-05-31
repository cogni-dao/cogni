# sandbox · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Sandbox adapter for AI agent execution — two modes: **ephemeral** containers (`network=none`, CLI invocation via dockerode) and **gateway** (long-running OpenClaw service on `sandbox-internal`, WS protocol). Both route LLM calls through nginx proxy to LiteLLM. Implements `SandboxRunnerPort`, `GraphExecutorPort`, `AgentCatalogProvider`.

## Active Priority (2026-02-12)

> **Gateway (long-lived OpenClaw) is the only active execution mode.**
> Ephemeral mode is **deprioritized** until further notice — do not invest in new ephemeral features, agents, or tests. All current work (task.0022 git relay, offline install, openclaw-coder) targets the gateway path.
>
> Rationale: OpenClaw is our primary AI brain, and ephemeral containers take too long to boot. The gateway container is already running with pnpm + git + devtools, named volumes (pnpm_store + cogni_workspace on same fs = hardlinks), and multi-turn agent loops. Ephemeral containers may be reintroduced in the future but are not a priority now.

## Pointers

- [Sandbox Spec](../../../../../../docs/spec/sandboxed-agents.md)
- [Sandbox Runtime](../../../../../../services/sandbox-runtime/)
- [Port Definition](../../../ports/sandbox-runner.port.ts)
- [Proxy Config Template](../../../../../../infra/compose/sandbox-proxy/nginx.conf.template)

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["ports", "shared", "types"],
  "must_not_import": ["app", "features", "core", "contracts"]
}
```

## Public Surface

- **Exports:** `SandboxRunnerAdapter`, `SandboxRunnerAdapterOptions`, `LlmProxyManager`, `LlmProxyConfig`, `LlmProxyHandle`, `ProxyStopResult`, `SandboxGraphProvider`, `SANDBOX_PROVIDER_ID`, `SandboxAgentCatalogProvider`, `OpenClawGatewayClient`, `GatewayAgentEvent`, `RunAgentOptions`
- **Env/Config keys:** `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN` (gateway mode); litellmMasterKey via constructor; image per-run via SandboxRunSpec
- **Files considered API:** index.ts barrel export (not re-exported from parent server barrel — consumers use subpath imports to avoid Turbopack bundling dockerode native addon chain)

## Ports

- **Uses ports:** none (SandboxGraphProvider uses SandboxRunnerPort internally)
- **Implements ports:** `SandboxRunnerPort` (adapter), `GraphExecutorPort` (sandbox-graph.provider), `AgentCatalogProvider` (sandbox-agent-catalog.provider)
- **Contracts:** tests/component/sandbox/, tests/stack/sandbox/

## Responsibilities

- This directory **does**: Create ephemeral Docker containers (network=none); manage gateway WS connections to long-running OpenClaw service (sandbox-internal); manage LLM proxy containers (nginx:alpine); share socket via Docker volume at `/llm-sock` (ephemeral) or TCP via Docker DNS (gateway); mount named Docker volumes; inject billing headers (ephemeral: proxy overwrites; gateway: outboundHeaders per-session, proxy passes through); collect stdout/stderr; handle timeouts and OOM; cleanup containers; route `sandbox:*` graphIds through graph execution pipeline; list sandbox agents in UI catalog. Gateway billing via LiteLLM callback (COST_AUTHORITY_IS_LITELLM).
- This directory **does not**: Implement agent logic (agent runs inside container); pass credentials to sandbox containers; manage the gateway container lifecycle (compose service)

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
- Gateway mode connects to long-running OpenClaw service via WS on `sandbox-internal`
- All capabilities dropped (`CapDrop: ['ALL']`), non-root user (`sandboxer`)
- Socket sharing via Docker volumes (not bind mounts) to avoid macOS osxfs issues and tmpfs masking
- All dockerode exec streams have bounded timeouts (never await unbounded `stream.on('end')`)
- Proxy containers labeled `cogni.role=llm-proxy` for sweep-based cleanup
- Gateway billing via LiteLLM generic_api callback (COST_AUTHORITY_IS_LITELLM, RECEIPT_WRITES_REQUIRE_CALL_ID_AND_COST)

## Dependencies

- **Internal:** ports/, shared/observability/
- **External:** dockerode, ws, nginx:alpine image, `cogni-sandbox-openclaw:latest` image

## Change Protocol

- Update this file when **Exports** or **Port implementations** change
- Bump **Last reviewed** date
- Ensure integration and stack tests pass

## Notes

- Requires `cogni-sandbox-runtime:latest` image built from services/sandbox-runtime/ (ephemeral mode)
- Requires `cogni-sandbox-openclaw:latest` for gateway mode (compose service)
- Requires `nginx:alpine` image for proxy containers
- Requires `sandbox-internal` Docker network for proxy ↔ LiteLLM connectivity
- `LlmProxyManager.cleanupSweep()` removes orphaned proxy containers by label filter
- Gateway WS protocol: custom frames, NOT JSON-RPC. See `openclaw-gateway-client.ts` header comment
