---
id: agent-development-guide
type: guide
title: Agent Development Guide
status: draft
trust: draft
summary: Step-by-step checklist for adding new agent graphs to shared and node-local LangGraph packages.
read_when: Adding a new AI agent graph — cross-node (packages/langgraph-graphs/) or node-only (nodes/<node>/graphs/).
owner: derekg1729
created: 2026-02-06
verified: 2026-04-27
tags: [ai, agents, dev]
---

# Agent Development Guide

> Quick reference for adding new agent graphs. For architecture details, see [LangGraph Patterns spec](../spec/langgraph-patterns.md).

## Billing-safe AI: the ONLY way to call an LLM

> [!CRITICAL]
> **Every LLM call in a node MUST flow through the graph executor.** It is the only path that runs the preflight credit gate AND records a usage receipt. Calling the raw LLM transport directly silently bills the end user with no credit check and no model choice — the exact defect that shipped in a forked node's "Research/Generate" panels (bug.5042). Fair billing is mission-critical; do not work around it.

**ALWAYS — pick one sanctioned entrypoint:**

1. **A catalog graph** (this guide) invoked via `GraphExecutorPort.runGraph` — for chat, agents, tool-using flows.
2. **The `completionStream` facade** (`@/app/_facades/ai/completion.server`) — for a one-shot server-side "research / generate / summarize". It starts the same billed `GraphRunWorkflow`. For a non-streaming result, drain the stream and `await final`:

   ```ts
   import { completionStream } from "@/app/_facades/ai/completion.server";

   const { stream, final } = await completionStream(
     { messages, modelRef, sessionUser /* who gets billed */ },
     ctx
   );
   for await (const _ of stream) {
     /* drain — required so billing fires (BILLING_INDEPENDENT_OF_CLIENT) */
   }
   const result = await final; // credit-gated + receipt recorded
   ```

   Pass `modelRef` from the user's `ModelPicker` selection — never hardcode a model. Insufficient credits surface as a terminal `error` event before the response commits; show it, don't swallow it.

**NEVER:**

- ❌ Inject `LlmService` into a feature/route and call `.completionStream(...)`. This skips the `PreflightCreditCheckDecorator` + `UsageCommitDecorator` stack. **CI fails** (`no-direct-completion-executestream.stack.test.ts`).
- ❌ Reach for a non-streaming `LlmService.completion(...)` — it was removed for this reason. Drain the stream + `await final` instead.
- ❌ Hardcode a "free" model to dodge the credit gate. Free vs paid is resolved server-side from the model catalog; the gate already returns 0 credits for free models.

**The ONE exception — platform/system billing (not the end user):** background jobs or platform features that must bill a _system_ account require **explicit human sign-off** and STILL route through the graph executor, bound to a designated system billing account. There is no sanctioned path that skips the executor. If you think you need one, file a bug linking your work item and ask first.

`LlmService` (`@/ports/llm.port`) is **executor-internal**: its only sanctioned consumers are `features/ai/services/completion.ts` and the in-proc completion adapter. See [graph-execution-spec](../spec/graph-execution.md) (`BILLABLE_AI_THROUGH_EXECUTOR`, `CREDITS_ENFORCED_AT_EXECUTION_PORT`).

## When to Use This

You are adding a new AI agent graph. This covers shared graph implementations (Tier 1a, `packages/langgraph-graphs`), node-local runtime catalogs (Tier 1b, `nodes/<node>/graphs/`), and composed multi-node graphs (Tier 2).

## Decide first: cross-node or node-only?

Per `SINGLE_DOMAIN_HARD_FAIL` (see [`node-ci-cd-contract.md`](../spec/node-ci-cd-contract.md#single-domain-scope)) and the bug.0319 substrate move, decide where the agent lives before scaffolding files:

| Question                                                                 | Put implementation in                          | Expose through                     | Reference graph |
| ------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------- | --------------- |
| Should every node runtime expose this agent? (e.g. `brain`, `poet`)      | `packages/langgraph-graphs/src/graphs/<name>/` | `NODE_LANGGRAPH_CATALOG`           | `ponderer/`     |
| Is this operator lifecycle-only? (e.g. `pr-manager`, `operating-review`) | `packages/langgraph-graphs/src/graphs/<name>/` | `OPERATOR_LANGGRAPH_CATALOG`       | `pr-manager/`   |
| Is this specific to one node fork?                                       | `nodes/<node>/graphs/src/graphs/<name>/`       | `nodes/<node>/graphs/src/index.ts` | local package   |

Default to the narrowest runtime catalog. Promoting node-local → shared is a deliberate hoist. Adding an operator lifecycle graph to the default node catalog leaks operator-only affordances into node-template forks.

## Preconditions

- [ ] `packages/langgraph-graphs` builds cleanly (`pnpm packages:build`)
- [ ] Agent purpose and required tools identified
- [ ] Familiar with the `ponderer/` graph as a reference implementation

## Steps

### Tier 1a: Shared Agent Implementation

**File Structure:**

```
packages/langgraph-graphs/src/graphs/<name>/
├── graph.ts        # Pure factory: createXGraph({ llm, tools })
├── prompts.ts      # System prompt constant(s)
├── tools.ts        # Tool IDs constant (*_TOOL_IDS)
├── server.ts       # LangGraph dev entrypoint
└── cogni-exec.ts   # Cogni executor entrypoint
```

**Steps:**

1. Create `graph.ts` — pure factory with `stateSchema: MessagesAnnotation`, NO explicit return type
2. Create `prompts.ts` — system prompt constant
3. Create `tools.ts` — export `*_TOOL_IDS` array referencing tool names from `@cogni/ai-tools`
4. Create `server.ts` — `export const x = await makeServerGraph({ name, createGraph, toolIds })`
5. Create `cogni-exec.ts` — `export const xGraph = makeCogniGraph({ name, createGraph, toolIds })`
6. Add entry to `catalog.ts`:
   - `NODE_LANGGRAPH_CATALOG` when every node should expose it
   - `OPERATOR_LANGGRAPH_CATALOG` when only operator should expose it
7. Add to `langgraph.json` — `"name": "./src/graphs/<name>/server.ts:x"`
8. Export from `graphs/index.ts`
9. Ensure each intended node graph package exports it through `LANGGRAPH_CATALOG`:
   - default nodes: `@cogni/node-template-graphs`, `@cogni/canary-graphs`, `@cogni/resy-graphs`
   - operator: `@cogni/operator-graphs`
10. **P0 UI workaround:** Add to `AVAILABLE_GRAPHS` in the intended `nodes/<node>/app/src/features/ai/components/ChatComposerExtras.tsx`

> **Note:** Step 10 is a temporary workaround. The runtime discovery route reads the node-local graph package, but the chat UI picker still uses a hardcoded graph list instead of fetching from `/api/v1/ai/agents`. See [Graph Execution](../spec/graph-execution.md) P1 checklist for the fix.

**Template:** Copy from `ponderer/`

**Verify:** `pnpm packages:build && pnpm langgraph:dev`

### Entrypoint Invariants

| Invariant                            | Rule                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------- |
| PURE_GRAPH_FACTORY                   | `graph.ts` has no env/ALS/entrypoint wiring                            |
| TYPE_TRANSPARENT_RETURN              | `graph.ts` has NO explicit return type (preserves CompiledStateGraph)  |
| ENTRYPOINT_IS_THIN                   | `server.ts` and `cogni-exec.ts` call `make*Graph` helpers              |
| LANGGRAPH_JSON_POINTS_TO_SERVER_ONLY | Never reference `cogni-exec.ts` in langgraph.json                      |
| NO_CROSSING_THE_STREAMS              | `server.ts` uses `initChatModel`; `cogni-exec.ts` uses ALS — never mix |

### Shared Types

From `packages/langgraph-graphs/src/graphs/types.ts`:

| Type                           | Purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `InvokableGraph<I, O>`         | Type firewall: `Pick<RunnableInterface, "invoke">` |
| `CreateReactAgentGraphOptions` | Base options: `{ llm, tools }`                     |
| `MessageGraphInput/Output`     | Mutable message arrays (LangGraph-aligned)         |

### Tier 1b: Node-Local Agent

**File Structure (no `server.ts` / `cogni-exec.ts` unless this node also runs a standalone LangGraph dev server):**

```
nodes/<node>/graphs/src/graphs/<name>/
├── graph.ts          # Pure factory: createXGraph({ llm, tools })
├── prompts.ts        # System prompt constant(s)
├── tools.ts          # Tool IDs constant; may import from @cogni/ai-tools (core) AND @cogni/<node>-ai-tools (node-scoped)
└── output-schema.ts  # Optional Zod schema for structured outputs
```

**Steps:**

1. Create graph files under `nodes/<node>/graphs/src/graphs/<name>/` (NOT `packages/langgraph-graphs`) when the implementation is node-specific.
2. `tools.ts` imports tool IDs from `@cogni/ai-tools` (cross-node `core__` IDs like `WEB_SEARCH_NAME`) and/or `@cogni/<node>-ai-tools` for node-scoped tools.
3. Export the node runtime catalog from `nodes/<node>/graphs/src/index.ts` as `LANGGRAPH_CATALOG`, `LANGGRAPH_GRAPH_IDS`, and `DEFAULT_LANGGRAPH_GRAPH_ID`. This keeps the app-facing shape identical across operator, node-template, canary, resy, and future node forks.
4. Confirm the node app depends on its graph package and imports catalog symbols from `@cogni/<node>-graphs`, not from `@cogni/langgraph-graphs`.
5. UI surfacing — `AVAILABLE_GRAPHS` in `nodes/<node>/app/src/features/ai/components/ChatComposerExtras.tsx` is hardcoded today; add the new `graphId` (e.g. `langgraph:<name>`) only for nodes that should show it.

**Reference:** current `nodes/<node>/graphs/src/index.ts` packages show the required app-facing export shape. Add node-specific graph folders beside that index when a fork needs local implementation.

### Tier 2: Composed Graphs

For multi-node graphs with node-keyed configuration, see [Graph Execution](../spec/graph-execution.md) § Node-Keyed Model & Tool Configuration.

## Verification

```bash
pnpm packages:build && pnpm langgraph:dev
```

For shared server-entrypoint graphs, verify the graph appears in LangGraph Studio and responds to test messages. For node-local runtime exposure, also run the owning node app typecheck and verify `/api/v1/ai/agents` on that node lists only the intended graph set.

## Troubleshooting

### Problem: Graph not appearing in LangGraph Studio

**Solution:** Ensure you added the entry to `langgraph.json` pointing to `server.ts` (not `cogni-exec.ts`). Check the LANGGRAPH_JSON_POINTS_TO_SERVER_ONLY invariant.

### Problem: Type error on graph return type

**Solution:** Do NOT add an explicit return type to `graph.ts`. The TYPE_TRANSPARENT_RETURN invariant requires the `CompiledStateGraph` type to flow through naturally.

## Related

- [Tools Authoring Guide](./tools-authoring.md) — Adding new tools for agents
- [LangGraph Patterns Spec](../spec/langgraph-patterns.md) — Architecture patterns
- [Graph Execution](../spec/graph-execution.md) — Execution invariants
