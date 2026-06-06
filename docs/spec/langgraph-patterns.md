---
id: langgraph-patterns-spec
type: spec
title: LangGraph Patterns
status: draft
spec_state: draft
trust: draft
summary: Architecture patterns and invariants for LangGraph agentic workflows across InProc and Server execution paths.
read_when: Working with LangGraph graphs, modifying AI execution pipeline, or understanding package boundaries.
implements:
owner: derekg1729
created: 2026-02-07
verified:
tags: [ai-graphs, langgraph]
---

# LangGraph Patterns

## Context

Cogni's baseline Open Source foundation for building and executing AI agent graphs is LangGraph. All LangGraph code is isolated in `packages/langgraph-graphs/`, with executor-agnostic primitives in `packages/ai-core/` and pure tool definitions in `packages/ai-tools/`. Both InProc (cogni-developed) and LanggraphServer (Langchain non-OSS) executors implement `GraphExecutorPort` for unified billing and telemetry.

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

8. **CATALOG_SINGLE_SOURCE_OF_TRUTH**: Catalog exported by `@cogni/langgraph-graphs`, references compiled graphs.

9. **NO_PARALLEL_REQUEST_TYPES**: Providers use `GraphRunRequest`/`GraphRunResult` from `@/ports`.

## Design

### Architecture Contract

| Category                | Status         | Notes                                                                |
| ----------------------- | -------------- | -------------------------------------------------------------------- |
| **Package structure**   | ✅ Implemented | ai-core, ai-tools, langgraph-graphs                                  |
| **Compiled exports**    | 📋 Contract    | Graphs export `compile()` with no args                               |
| **TOOL_CATALOG**        | 📋 Contract    | Canonical registry in `ai-tools`; wrapper checks `toolIds` allowlist |
| **ALS runtime context** | 📋 Contract    | `getCogniExecContext()` per-run isolation                            |

> See [Graph Execution](graph-execution.md) for authoritative invariants and implementation status.

### Execution Paths

| Path       | Adapter                       | Use Case                                             |
| ---------- | ----------------------------- | ---------------------------------------------------- |
| **InProc** | `InProcCompletionUnitAdapter` | Next.js process; billing via executeCompletionUnit() |
| **Server** | `LangGraphServerAdapter`      | External LangGraph Server container                  |

All AI execution flows through `GraphExecutorPort`. The executor choice is an implementation detail behind the unified interface.

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
└── langgraph-graphs/                 # ALL LangChain code lives here
    └── src/
        ├── catalog.ts                # LANGGRAPH_CATALOG (graph metadata)
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
```

**Supported import surface:**

```typescript
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
| `LangGraphCatalogEntry`             | `langgraph/catalog.ts` | `LangGraphInProcProvider`            |

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
│ - Looks up compiled graph from catalog                              │
│ - Sets up AsyncLocalStorage context (completionFn, tokenSink)       │
│ - Invokes: graph.invoke(messages, { configurable })                 │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Compiled Graph (packages/langgraph-graphs/src/graphs/*)             │
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

| Package                   | Owns                                  | Dependencies                         |
| ------------------------- | ------------------------------------- | ------------------------------------ |
| `@cogni/ai-tools`         | `TOOL_CATALOG`, contracts, schemas    | `zod` only                           |
| `@cogni/langgraph-graphs` | `toLangChainTool` (wraps + allowlist) | `@cogni/ai-tools`, `@langchain/core` |

### Autoresearch Run Specs

Autoresearch graphs require a comparable run envelope when launched as an
experiment family. The envelope is `AutoresearchRunSpec` from `@cogni/ai-core`
and may travel on `GraphRunRequest.autoresearch`, then through
`RunnableConfig.configurable.autoresearch`.

The spec is JSON-serializable and carries:

| Field             | Purpose                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `mission`         | objective, question, target graph, mutable surface, and non-goals                                                         |
| `rewardMetric`    | one calculable KPI, formula, direction, baseline, target delta, source, keep/revert thresholds, and human thumbs fallback |
| `memory`          | ordered retrieval layers plus domains, recall queries, confidence floor, citation minimum, and time-priority policy       |
| `budget`          | cost, wall-clock, LLM-call, and tool-call caps                                                                            |
| `edo`             | optional hypothesis/evidence links and later resolution strategy                                                          |
| `fanout`          | bounded variant, lane, recall, web, repo, and turn budgets                                                                |
| `driftGuard`      | stop conditions and path boundaries                                                                                       |
| `stopCriteria`    | explicit metric, budget, recall, and human stop conditions                                                                |
| `selectionPolicy` | `best_reward`, `pareto`, or `judge_then_reward`                                                                           |

This keeps the graph variants prompt-driven while preventing 10 spawned runs
from silently optimizing different goals. Scheduled launchers should also render
the same spec into visible task context as `AUTORESEARCH_RUN_SPEC` until every
execution backend can inject configurable values into the system prompt.

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

### File Pointers

| File                                                                | Purpose                                   |
| ------------------------------------------------------------------- | ----------------------------------------- |
| `packages/ai-core/src/events/ai-events.ts`                          | AiEvent union type                        |
| `packages/ai-core/src/tooling/tool-runner.ts`                       | createToolRunner (canonical pipeline)     |
| `packages/ai-tools/src/catalog.ts`                                  | TOOL_CATALOG registry                     |
| `packages/langgraph-graphs/src/catalog.ts`                          | LANGGRAPH_CATALOG (graph metadata)        |
| `packages/langgraph-graphs/src/graphs/index.ts`                     | Barrel: inproc entrypoints                |
| `packages/langgraph-graphs/src/runtime/cogni/exec-context.ts`       | CogniExecContext, runWithCogniExecContext |
| `packages/langgraph-graphs/src/runtime/cogni/completion-adapter.ts` | CogniCompletionAdapter                    |
| `packages/langgraph-graphs/src/runtime/cogni/entrypoint.ts`         | createCogniEntrypoint                     |
| `packages/langgraph-graphs/src/runtime/core/server-entrypoint.ts`   | createServerEntrypoint                    |
| `packages/langgraph-graphs/langgraph.json`                          | LangGraph Server graph registration       |

## Acceptance Checks

**Automated:**

- `pnpm packages:build` — all three packages (ai-core, ai-tools, langgraph-graphs) build without errors
- Biome `noRestrictedImports` rule enforces NO_LANGCHAIN_IN_SRC

**Manual:**

1. Verify no `@langchain/*` imports exist in `src/` (`grep -r "@langchain" src/`)
2. Verify graph catalog entries reference compiled graphs

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
