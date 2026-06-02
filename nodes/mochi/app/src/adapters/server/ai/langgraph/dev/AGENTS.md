# langgraph/dev · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

LangGraph dev server adapter. Connects to external `langgraph dev` server (port 2024) for local development. Translates SDK streams to AiEvent format and derives tenant-scoped thread IDs.

## Pointers

- [LangGraph Server Design](../../../../../../../../docs/spec/langgraph-server.md)
- [Graph Execution](../../../../../../../../docs/spec/graph-execution.md)
- [Parent ai/ AGENTS.md](../../../../../../../../AGENTS.md)

## Boundaries

```json
{
  "layer": "adapters/server",
  "may_import": ["adapters/server", "ports", "shared", "types"],
  "must_not_import": ["app", "features", "core"]
}
```

## Public Surface

- **Exports:**
  - `LangGraphDevProvider` — Implements GraphExecutorPort for dev server execution
  - `LangGraphDevAgentCatalogProvider` — Implements AgentCatalogProvider for dev server discovery
  - `createDevClient()` — SDK client factory
  - `deriveThreadId()` — UUIDv5 thread derivation from billingAccountId + stateKey
  - `translateSdkStreamToAiEvents()` — SDK stream to AiEvent translation
- **Env/Config keys:** `LANGGRAPH_DEV_URL` (enables dev server path when set)
- **Files considered API:** `index.ts`, `provider.ts`, `agent-catalog.provider.ts`

## Ports

- **Uses ports:** none
- **Implements ports:** GraphExecutorPort (via `LangGraphDevProvider`), AgentCatalogProvider (via `LangGraphDevAgentCatalogProvider`)
- **Contracts:** none (dev-only adapter)

## Responsibilities

- This directory **does**: Connect to langgraph dev server via @langchain/langgraph-sdk, translate SDK streams to AiEvent, derive tenant-scoped thread IDs
- This directory **does not**: Execute graphs directly, import @langchain/\* (SDK only), handle billing (dev server is not customer-billable)

## Usage

```bash
# Start langgraph dev server
pnpm langgraph:dev

# Set env to enable dev adapter
LANGGRAPH_DEV_URL=http://localhost:2024
```

## Standards

- STABLE_GRAPH_IDS: graphIds are `langgraph:{graphName}` regardless of backend
- THREAD_ID_IS_UUID: Thread IDs are UUIDv5 derived from `(billingAccountId, stateKey)`
- THREAD_KEY_REQUIRED: stateKey required for stateful conversations
- SDK_CHUNK_SHAPE: SDK stream uses `chunk.event` + `chunk.data` (not `event.type`)
- DEV_TOOL_EVENT_STREAMING: Emits tool_call_start/tool_call_result with chunk buffering (64KB args, 100 pending)
- MVP: No billing parity (see LANGGRAPH_SERVER.md limitations)

## Dependencies

- **Internal:** ports, shared/env, shared/observability/logging
- **External:** @langchain/langgraph-sdk, uuid

## Change Protocol

- Update this file when exports or env keys change
- Coordinate with LANGGRAPH_SERVER.md invariants

## Notes

- Per MUTUAL_EXCLUSION: Register exactly one `langgraph` provider per aggregator (InProc XOR Dev)
- Dev adapter is MVP only; P1 uses Docker-based langgraph server with full billing parity
