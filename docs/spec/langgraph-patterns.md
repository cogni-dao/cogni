---
id: langgraph-patterns-spec
type: spec
title: LangGraph Patterns
status: draft
spec_state: draft
trust: draft
summary: Architecture patterns and invariants for node-owned LangGraph graphs, including composition inside durable Temporal agent workflows.
read_when: Working with LangGraph graphs, durable agent workflows, AI execution, or graph package boundaries.
implements:
owner: derekg1729
created: 2026-02-07
verified: 2026-10-09
tags: [ai-graphs, langgraph]
---

# LangGraph Patterns

## Context

Cogni's baseline Open Source foundation for building and executing AI agent graphs is LangGraph. Shared graph implementations and runtime helpers live in `packages/langgraph-graphs/`; node runtimes expose their effective catalog through `nodes/<node>/graphs/` packages such as `@cogni/operator-graphs` and `@cogni/node-template-graphs`. Executor-agnostic primitives live in `packages/ai-core/`, and pure tool definitions live in `packages/ai-tools/`. Both InProc (cogni-developed) and LangGraph Server (LangChain non-OSS) executors implement `GraphExecutorPort` for unified billing and telemetry.

## Goal

Define the package boundaries, execution paths, and invariants that govern LangGraph graph creation and execution. Ensure all AI execution flows through `GraphExecutorPort` regardless of executor choice. Custom InProc langraph executor must model as closely to LangGraph Server's I/O for graph execution as possible.

## Non-Goals

- Server infrastructure details (Docker, Redis, container deployment) — see [LangGraph Server](../LANGGRAPH_SERVER.md)
- Executor-agnostic billing and tracking patterns — see [Graph Execution](graph-execution.md)
- Step-by-step guide for adding new graphs — see [Agent Development Guide](../guides/agent-development.md)

## Core Invariants

1. **NO_LANGCHAIN_IN_SRC**: `src/**` cannot import `@langchain/*`. Enforced by Biome `noRestrictedImports`.

2. **PACKAGES_NO_SRC_IMPORTS**: `packages/**` cannot import from `src/**`. Enforced by dependency-cruiser.

3. **ENV_FREE_EXPORTS**: Package exports never read `env.ts` or instantiate provider SDKs directly.

4. **SINGLE_AIEVENT_CONTRACT**: Common subset: `text_delta`, `usage_report`, `assistant_final`, `done`. Tool events are InProc-only for P0.

5. **NO_AWAIT_IN_TOKEN_PATH**: Token emission → AiEvent yield must not await I/O. Use synchronous queue push.

6. **SINGLE_QUEUE_PER_RUN**: Each graph run owns exactly one AsyncQueue. Tool events and LLM events flow to the same queue.

7. **ASSISTANT_FINAL_REQUIRED**: On success, emit exactly one `assistant_final` event with complete response.

8. **NODE_RUNTIME_CATALOG_BOUNDARY**: App runtimes import `LANGGRAPH_CATALOG`, `LANGGRAPH_GRAPH_IDS`, and `DEFAULT_LANGGRAPH_GRAPH_ID` from their node-local graph package (`@cogni/<node>-graphs`). Shared `@cogni/langgraph-graphs` owns reusable graph implementations plus base catalogs, not app runtime policy.

9. **NO_PARALLEL_REQUEST_TYPES**: Providers use `GraphRunRequest`/`GraphRunResult` from `@/ports`.

10. **GRAPH_IS_NOT_THE_DURABLE_OUTER_LOOP**: LangGraph owns reasoning and graph-state checkpoints. Temporal owns schedules, cross-graph coordination, retries around external boundaries, timers, signals, and externally visible writes. A scheduled or long-lived agent is a Temporal Workflow containing graph runs, not a graph pretending to be the scheduler.

11. **NODE_OWNS_EFFECTIVE_GRAPH_AND_WORKFLOW_CATALOGS**: A node's `packages/graphs` and `packages/workflows` are released together with its app and Worker. Shared packages supply runtime mechanics; they never select a node's product graph or workflow policy.

12. **PERSISTENCE_IS_EXPLICIT**: In-memory LangGraph checkpointers are development-only. A production graph that must resume inside a run uses a persistent checkpointer and stable `thread_id`. Temporal history does not automatically checkpoint internal LangGraph nodes when a whole graph is executed as one Activity.

## Design

### Architecture Contract

| Category                | Status         | Notes                                                                |
| ----------------------- | -------------- | -------------------------------------------------------------------- |
| **Package structure**   | ✅ Implemented | ai-core, ai-tools, langgraph-graphs, nodes/<node>/graphs             |
| **Compiled exports**    | 📋 Contract    | Graphs export `compile()` with no args                               |
| **TOOL_CATALOG**        | 📋 Contract    | Canonical registry in `ai-tools`; wrapper checks `toolIds` allowlist |
| **ALS runtime context** | 📋 Contract    | `getCogniExecContext()` per-run isolation                            |

> See [Graph Execution](graph-execution.md) for authoritative invariants and implementation status.

### Execution Paths

| Path                 | Adapter                                                                  | Use Case                                                                 |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **InProc**           | `InProcCompletionUnitAdapter`                                            | Next.js process; billing via executeCompletionUnit()                     |
| **Server**           | `LangGraphServerAdapter`                                                 | External LangGraph Server container                                      |
| **Durable workflow** | Node-owned Temporal Worker → private graph-run API → `GraphExecutorPort` | Scheduled/multi-step/HITL orchestration with graph runs as durable steps |

All AI execution flows through `GraphExecutorPort`. The executor choice is an implementation detail behind the unified interface.

### Durable Agent Workflow Composition

An "AI graph workflow" is named a **durable agent workflow** in Cogni: a Temporal Workflow
containing one or more LangGraph runs plus durable Activities, timers, signals, or child
Workflows. This makes the two state machines explicit instead of blending their guarantees.

```text
Temporal Schedule / API / webhook
  → node-owned Temporal Workflow                 durable outer state machine
      → Activity or child: run graph             retry/idempotency boundary
          → node app GraphExecutorPort
              → node-owned LangGraph catalog     reasoning/dataflow state machine
                  → persistent checkpointer      optional intra-graph resume/HITL
      → Activity: commit/publish result           idempotent external write
```

The Pareto implementation deliberately calls the node app's private graph-run API. That path
already owns execution grants, `graph_runs`, billing receipts, streaming, and AI telemetry.
Running LangGraph directly inside the Worker would create a second billable execution path
unless the complete graph-execution host is first made process-portable. It is a valid later
optimization, not the P0 architecture.

Durability is layered:

| Failure boundary                     | Recovery owner                     | Required identity             |
| ------------------------------------ | ---------------------------------- | ----------------------------- |
| Worker process restart between steps | Temporal history                   | Workflow ID + Worker Build ID |
| Whole graph Activity retry           | Temporal + graph-run idempotency   | schedule/run/step key         |
| Graph node interruption/restart      | LangGraph checkpointer             | stable `thread_id`            |
| External write retry                 | Temporal Activity + receiver dedup | stable business key           |

Do not enable retries at all layers blindly. The Temporal Activity retry is the outer policy;
graph/provider retries remain bounded, and externally visible effects must deduplicate on a
business key independent of attempt number.

### Package Structure

```
packages/
├── ai-core/                          # Executor-agnostic primitives (NO LangChain)
│   └── src/
│       ├── events/ai-events.ts       # AiEvent union
│       ├── usage/usage.ts            # UsageFact, ExecutorType
│       ├── configurable/             # GraphRunConfig schema
│       └── tooling/                  # Tool execution types + runtime
│           ├── types.ts              # ToolExecFn, BoundToolRuntime, EmitAiEvent
│           ├── tool-runner.ts        # createToolRunner (canonical pipeline)
│           ├── ai-span.ts            # AiSpanPort (observability interface)
│           └── runtime/tool-policy.ts # ToolPolicy, createToolAllowlistPolicy
│
├── ai-tools/                         # Pure tool definitions (NO LangChain)
│   └── src/
│       ├── types.ts                  # ToolContract, BoundTool, ToolResult
│       ├── catalog.ts                # TOOL_CATALOG: Record<string, BoundTool>
│       └── tools/*.ts                # Pure implementations
│
└── langgraph-graphs/                 # Shared LangChain graph implementations and helpers
    └── src/
        ├── catalog.ts                # NODE_LANGGRAPH_CATALOG, OPERATOR_LANGGRAPH_CATALOG, default node exports
        ├── graphs/                   # Graph definitions
        │   ├── index.ts              # Barrel: inproc entrypoints
        │   ├── poet/
        │   │   ├── graph.ts          # Pure factory: createPoetGraph({ llm, tools })
        │   │   ├── server.ts         # langgraph dev entrypoint (initChatModel)
        │   │   ├── cogni-exec.ts     # Cogni executor entrypoint (ALS-based)
        │   │   └── prompts.ts        # System prompts
        │   └── <agent>/
        │       ├── graph.ts          # Pure factory
        │       ├── server.ts         # langgraph dev entrypoint
        │       ├── cogni-exec.ts     # Cogni executor entrypoint
        │       └── prompts.ts        # System prompts
        └── runtime/                  # Runtime utilities
            ├── core/                 # Generic (no ALS)
            │   ├── async-queue.ts
            │   ├── message-converters.ts
            │   ├── langchain-tools.ts   # makeLangChainTools, toLangChainToolsCaptured
            │   └── server-entrypoint.ts
            └── cogni/                # Cogni executor (uses ALS)
                ├── exec-context.ts      # CogniExecContext, runWithCogniExecContext
                ├── completion-adapter.ts # CogniCompletionAdapter (Runnable-based)
                ├── tools.ts             # toLangChainToolsFromContext
                └── entrypoint.ts        # createCogniEntrypoint
nodes/
└── <node>/
    └── graphs/                       # Node runtime graph package
        └── src/
            └── index.ts              # Exports LANGGRAPH_CATALOG for this node runtime
```

**Supported import surface:**

```typescript
// App runtime catalog policy
import { LANGGRAPH_CATALOG } from "@cogni/operator-graphs";
import { LANGGRAPH_CATALOG } from "@cogni/node-template-graphs";

// Compiled graph exports
import { poetGraph, pondererGraph } from "@cogni/langgraph-graphs/graphs";

// Runtime utilities
import {
  CogniCompletionAdapter,
  toBaseMessage,
} from "@cogni/langgraph-graphs/runtime";
```

### Type Boundaries

| Type                                | Defined In             | Used By                              |
| ----------------------------------- | ---------------------- | ------------------------------------ |
| `GraphRunRequest`, `GraphRunResult` | `@/ports`              | `GraphExecutorPort`, `GraphProvider` |
| `GraphRunConfig`                    | `@cogni/ai-core`       | All adapters, graphs                 |
| `LangGraphCatalogEntry`             | `langgraph/catalog.ts` | Node graph packages, providers       |

### Persistence Integration

Persistence is handled by parallel stream subscribers — runner owns event emission, not storage:

| Subscriber            | Event              | Action                                |
| --------------------- | ------------------ | ------------------------------------- |
| **BillingSubscriber** | `usage_report`     | `commitUsageFact()` → charge_receipts |
| **UI Subscriber**     | `text_delta`, etc. | Forward to client (may disconnect)    |

Key contracts from [Thread Persistence spec](./thread-persistence.md):

- **UIMESSAGE_IS_CONTRACT**: Thread messages stored as AI SDK `UIMessage[]` JSONB. No bespoke artifact tables.
- **REDACT_BEFORE_PERSIST**: PII masking applied before `saveThread()`. Single redaction boundary.
- **TENANT_SCOPED**: All `ai_threads` rows include `owner_user_id`. RLS enforces isolation via `app.current_user_id`.

Runner responsibility: Emit `assistant_final` with complete content. Route accumulates AiEvents into response UIMessage for persistence.

### InProc Execution Path

InProc executes LangGraph within the Next.js server runtime with billing through the adapter layer.

**Data Flow:**

```
┌─────────────────────────────────────────────────────────────────────┐
│ AiRuntimeService.runGraph(request)                                  │
│ - Routes via AggregatingGraphExecutor by graphId                    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ LangGraphInProcProvider                                             │
│ - Looks up compiled graph from node-local runtime catalog            │
│ - Sets up AsyncLocalStorage context (completionFn, tokenSink)       │
│ - Invokes: graph.invoke(messages, { configurable })                 │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Compiled Graph (packages/langgraph-graphs/src/graphs/* or nodes/*)  │
│ - Accesses runtime via getCogniExecContext()                        │
│ - LLM calls route through CogniCompletionAdapter                    │
│ - Tools resolved by toolIds via ToolRegistry                        │
└─────────────────────────────────────────────────────────────────────┘
```

**CogniCompletionAdapter** (`runtime/cogni/completion-adapter.ts`) is a `Runnable`-based wrapper that routes LLM calls through the ALS-provided `CompletionFn` for billing/streaming integration.

Key design:

- Extends `Runnable` (not `BaseChatModel`) so `configurable` is available in `invoke()`
- Model read from `config.configurable.model`
- Non-serializable deps (`completionFn`, `tokenSink`) from ALS
- Includes `_modelType()` for LangGraph duck-typing compatibility
- Fails fast if ALS context or model missing

**Runtime Context:** The provider sets up ALS context before graph invocation. Per NO_MODEL_IN_ALS (see [Graph Execution](graph-execution.md)), the runtime holds only non-serializable dependencies (`completionFn`, `tokenSink`, `toolExecFn`). Model travels via `configurable`.

### Server Execution Path

LangGraphServerAdapter calls external LangGraph Server via SDK. Server owns thread state/checkpoints and routes LLM through LiteLLM proxy. `stateKey` is required; send only new user input; server owns thread state. Tools work per-run. InProc path ignores `stateKey` (no thread persistence).

See [LangGraph Server](../LANGGRAPH_SERVER.md) for infrastructure details.

### Tool Structure

Tool schemas are bound at graph compile time. `configurable.toolIds` is a **runtime allowlist** checked at execution:

```typescript
// @cogni/ai-tools/catalog.ts - canonical registry
export const TOOL_CATALOG = {
  core__get_current_time: getCurrentTimeBoundTool,
  core__web_search: webSearchBoundTool,
};

// toLangChainTool wrapper checks allowlist at execution
func: async (args, runManager?, config?) => {
  const allowed = config?.configurable?.toolIds ?? [];
  if (!allowed.includes(toolName)) {
    return { ok: false, errorCode: "policy_denied", safeMessage: "..." };
  }
  return exec(toolName, args, config?.configurable);
};
```

| Package                   | Owns                                  | Dependencies                                        |
| ------------------------- | ------------------------------------- | --------------------------------------------------- |
| `@cogni/ai-tools`         | `TOOL_CATALOG`, contracts, schemas    | `zod` only                                          |
| `@cogni/langgraph-graphs` | `toLangChainTool` (wraps + allowlist) | `@cogni/ai-tools`, `@langchain/core`                |
| `@cogni/<node>-graphs`    | Node runtime catalog policy           | `@cogni/langgraph-graphs`, optional node graph code |

For node-at-root repositories, the target names are `packages/graphs` (effective node graph
catalog), `packages/workflows` (Temporal orchestration referring to graph IDs), and
`services/workflow-worker` (process composition). Shared mechanics arrive through pinned,
published `@cogni-dao/*` packages; node business definitions are never published as substrate.

### langgraph.json Configuration

For Server path, graphs are registered in `packages/langgraph-server/langgraph.json`:

```json
{
  "node_version": "20",
  "graphs": {
    "chat": "./src/index.ts:chatGraph",
    "my-agent": "./src/index.ts:myAgentGraph"
  },
  "env": ".env"
}
```

The `langgraph-server` package re-exports graphs from `@cogni/langgraph-graphs/graphs`.

### Anti-Patterns

1. **No `@langchain` imports in `src/`** — All LangChain code in `packages/langgraph-graphs/`
2. **No hardcoded models in graphs** — Model comes from ALS (provider sets from `configurable.model`)
3. **No direct `ChatOpenAI` in InProc** — Use `CogniCompletionAdapter` wrapper for billing
4. **No tool instances in configurable** — Pass `toolIds`, resolve via registry
5. **No constructor args on graph exports** — Graphs compile with no args; runtime config via `configurable`
6. **No env reads in package exports** — Use `AsyncLocalStorage` context
7. **No `await` in token sink** — `tokenSink.push()` must be synchronous
8. **No `streamEvents()` for InProc** — Use `invoke()` + AsyncQueue
9. **No forked tool wrapper logic** — Single `makeLangChainTools` impl; thin wrappers resolve `toolExecFn` differently
10. **No constructor args on `CogniCompletionAdapter`** — No-arg constructor; reads model from `configurable` and deps from ALS at invoke time
11. **No full graph run hidden in a long synchronous HTTP handler without idempotency** — a Worker retry can otherwise rerun and recharge it
12. **No material side effect inside a graph node without a durable idempotency boundary** — return a decision artifact and commit it in a Temporal Activity
13. **No assumption that Temporal history checkpoints LangGraph nodes** — use a persistent LangGraph checkpointer when intra-graph recovery matters

### File Pointers

| File                                                                | Purpose                                   |
| ------------------------------------------------------------------- | ----------------------------------------- |
| `packages/ai-core/src/events/ai-events.ts`                          | AiEvent union type                        |
| `packages/ai-core/src/tooling/tool-runner.ts`                       | createToolRunner (canonical pipeline)     |
| `packages/ai-tools/src/catalog.ts`                                  | TOOL_CATALOG registry                     |
| `packages/langgraph-graphs/src/catalog.ts`                          | Shared base catalogs and graph metadata   |
| `packages/langgraph-graphs/src/graphs/index.ts`                     | Barrel: inproc entrypoints                |
| `packages/langgraph-graphs/src/runtime/cogni/exec-context.ts`       | CogniExecContext, runWithCogniExecContext |
| `packages/langgraph-graphs/src/runtime/cogni/completion-adapter.ts` | CogniCompletionAdapter                    |
| `packages/langgraph-graphs/src/runtime/cogni/entrypoint.ts`         | createCogniEntrypoint                     |
| `packages/langgraph-graphs/src/runtime/core/server-entrypoint.ts`   | createServerEntrypoint                    |
| `packages/langgraph-graphs/langgraph.json`                          | LangGraph Server graph registration       |
| `nodes/<node>/graphs/src/index.ts`                                  | Effective runtime catalog for one node    |
| node `packages/workflows/`                                          | Temporal workflows composing graph IDs    |
| node `services/workflow-worker/`                                    | Worker lifecycle and Activity composition |

## Acceptance Checks

**Automated:**

- `pnpm packages:build` — all three packages (ai-core, ai-tools, langgraph-graphs) build without errors
- Biome `noRestrictedImports` rule enforces NO_LANGCHAIN_IN_SRC

**Manual:**

1. Verify no `@langchain/*` imports exist in `src/` (`grep -r "@langchain" src/`)
2. Verify node app imports catalog symbols from `@cogni/<node>-graphs`
3. Verify graph catalog entries reference compiled graphs
4. For each durable agent workflow, verify the graph step reaches `GraphExecutorPort` once and carries a stable idempotency key
5. Verify production graphs requiring intra-run resume use a persistent checkpointer and stable `thread_id`

## Open Questions

- [ ] Stream controller "already closed" error — non-blocking; stream completes despite error on client disconnect
- [ ] Tool call ID architecture — P0 workaround generates UUID; should propagate model's `tool_call_id`

## Related

- [Agent Development Guide](../guides/agent-development.md) — Step-by-step for adding new agent graphs
- [Graph Execution](graph-execution.md) — Executor-agnostic billing, tracking, UI/UX patterns
- [LangGraph Server](../LANGGRAPH_SERVER.md) — Infrastructure: Docker, Redis, container deployment
- [Tool Use Spec](./tool-use.md) — Tool execution invariants
- [Thread Persistence Spec](./thread-persistence.md) — UIMessage persistence, assistant_final accumulation
- [AI Setup Spec](./ai-setup.md) — Correlation IDs, telemetry
- [Temporal Patterns](./temporal-patterns.md) — Node-owned durable orchestration and deployment topology
