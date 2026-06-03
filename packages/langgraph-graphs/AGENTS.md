# langgraph-graphs · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

LangGraph graph definitions and runtime utilities for agentic AI execution. Contains all `@langchain/*` code in the monorepo. Provides graph factories, message converters, tool wrappers, and streaming utilities.

## Pointers

- [LangGraph AI Guide](../../docs/spec/langgraph-patterns.md)
- [Graph Execution](../../docs/spec/graph-execution.md)
- [Tool Use Spec](../../docs/spec/tool-use.md)
- [Packages Architecture](../../docs/spec/packages-architecture.md)

## Boundaries

```json
{
  "layer": "packages",
  "may_import": ["packages"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services"
  ]
}
```

**External deps:** `@langchain/core`, `@langchain/langgraph`, `@langchain/mcp-adapters`, `zod`. Imports `@cogni/ai-core`, `@cogni/ai-tools`.

## Public Surface

- **Exports (subpaths):**
  - `@cogni/langgraph-graphs` — Barrel re-export of common types plus:
    - `LANGGRAPH_CATALOG` — Graph catalog with registered graphs and metadata
    - `McpToolSource` — ToolSourcePort implementation for MCP-discovered tools
    - `loadMcpTools()`, `parseMcpConfigFromEnv()` — MCP client connection + config parsing
    - `McpHttpServerConfig`, `McpSseServerConfig`, `McpStdioServerConfig` — Transport config types
  - `@cogni/langgraph-graphs/inproc` — InProc execution runner:
    - `createInProcGraphRunner()` — Generic InProc graph runner factory
    - `InProcRunnerOptions`, `InProcGraphRequest`, `GraphResult` (includes optional `structuredOutput`) — Runner types
    - `CompletionFn`, `CompletionResult` — Injected completion function types
    - `CreateGraphFn`, `CreateGraphOptions` — Graph factory types
    - `ToolExecFn`, `ToolExecResult` — Tool execution types
  - `@cogni/langgraph-graphs/runtime` — LangChain utilities (split: `core/` generic, `cogni/` ALS-based):
    - **Core (no ALS):** `makeLangChainTool()`, `toLangChainToolsCaptured()`, `toBaseMessage()`, `fromBaseMessage()`, `AsyncQueue`, `makeServerGraph()`
    - **Cogni (uses ALS):** `CogniCompletionAdapter` (with `withStructuredOutput()` for Zod/JSON Schema response parsing), `runWithCogniExecContext()`, `getCogniExecContext()`, `hasCogniExecContext()`, `toLangChainToolsFromContext()`, `makeCogniGraph()`
    - `CogniExecContext` — Runtime context type (completionFn, tokenSink, toolExecFn; NO model per #35)
  - `@cogni/langgraph-graphs/graphs` — Graph factories and shared types:
    - `createAutoresearchGraph()` — prompt-driven Karpathy-style autoresearch factory for `autoresearch-single-lane`, `autoresearch-syntropy-loop`, and `autoresearch-registry-swarm`
    - `createPoetGraph()`, `createPondererGraph()` — React agent factories (TYPE_TRANSPARENT_RETURN)
    - `createBrainGraph()` — Code-aware ReAct agent with repo tools (list, search, open)
    - `createResearchGraph()` — 3-node MVP research graph (plan_queries → web_search_fanout → rank_and_report)
    - `createPrReviewGraph()` — Single-call structured output graph for PR review (no tools, `responseFormat` for typed metrics)
    - `createBrowserGraph()` — Browser automation agent via Playwright MCP (mcpServerIds: ["playwright"])
    - `createFrontendTesterGraph()` — QA agent for UI testing via Playwright MCP
    - `PR_MANAGER_GRAPH_NAME`, `PR_MANAGER_PROMPT` — PR Manager agent (merge bot, reads evolving playbook)
    - `PR_MANAGER_TOOL_IDS` — VCS tools + repo_open (for playbook) + work_item_query
    - `POET_GRAPH_NAME`, `PONDERER_GRAPH_NAME`, `BRAIN_GRAPH_NAME`, `RESEARCH_GRAPH_NAME`, `PR_REVIEW_GRAPH_NAME`, `BROWSER_GRAPH_NAME`, `FRONTEND_TESTER_GRAPH_NAME` — Graph name constants
    - `InvokableGraph<I,O>`, `MessageGraphInput`, `MessageGraphOutput` — Type firewall
    - `GraphInvokeOptions`, `CreateReactAgentGraphOptions` — Factory types
  - **Per-graph tools:** `src/graphs/*/tools.ts` exports `*_TOOL_IDS` constants (e.g., `BRAIN_TOOL_IDS`, `BrainToolId`)
- **Env/Config keys:** none (all deps injected)
- **Files considered API:** `index.ts`, `inproc/index.ts`, `runtime/index.ts`, `graphs/index.ts`, `langgraph.json`
- **Server entrypoints:** `src/graphs/*/server.ts` — LangGraph dev server (uses `makeServerGraph`)
- **Cogni entrypoints:** `src/graphs/*/cogni-exec.ts` — Cogni executor (uses `makeCogniGraph`)

## Ports

- **Uses ports:** none (pure package, no ports)
- **Implements ports:** none

## Responsibilities

- This directory **does**: Define LangGraph graphs, wrap tools for LangChain, convert message formats
- This directory **does not**: Import from `src/`, execute graphs (runners in `src/`), own billing logic

## Usage

```bash
pnpm --filter @cogni/langgraph-graphs typecheck
pnpm --filter @cogni/langgraph-graphs build
pnpm --filter @cogni/langgraph-graphs test
```

## Standards

- All `@langchain/*` imports must stay in this package (NO_LANGCHAIN_IN_SRC)
- Graph factories are pure functions — no env reads, no side effects
- PURE_GRAPH_FACTORY: `graph.ts` has no env/ALS/entrypoint wiring
- TYPE_TRANSPARENT_RETURN: Graph factories have NO explicit return type annotation to preserve `CompiledStateGraph` for CLI schema extraction
- ENTRYPOINT_IS_THIN: `server.ts` and `cogni-exec.ts` are ~1-liners calling `makeServerGraph`/`makeCogniGraph`
- NO_CROSSING_THE_STREAMS: `server.ts` uses `initChatModel`; `cogni-exec.ts` uses ALS — never mix
- TOOLS_DENY_BY_DEFAULT: toLangChainTool checks configurable.toolIds; returns policy_denied if not in list
- TOOL_CATALOG_IS_CANONICAL: `LANGGRAPH_CATALOG` entries use `toolIds: string[]` references; providers resolve from `TOOL_CATALOG`

## Dependencies

- **Internal:** `@cogni/ai-core` (AiEvent types), `@cogni/ai-tools` (ToolContract, BoundTool)
- **External:** `@langchain/core`, `@langchain/langgraph`, `zod`

## Change Protocol

- Update this file when public exports change
- Changes to graph contracts require updating `src/adapters/server/ai/langgraph/inproc.provider.ts`
- Coordinate with LANGGRAPH_AI.md invariants

## Notes

- Per NO_LANGCHAIN_IN_SRC: `src/**` cannot import `@langchain/*` — only this package
- Per PACKAGES_NO_SRC_IMPORTS: This package cannot import from `src/**`
- `LangGraphInProcProvider` in `src/adapters/server/ai/langgraph/` wires this package
- Package isolation enables LangGraph Server to import graphs without Next.js deps
- **Dual tsconfig:** LangGraph CLI generates runtime `.ts` files (`__langgraph__*.ts`) that break `composite` mode. This package uses `tsconfig.json` (noEmit, for CLI) + `tsconfig.build.json` (composite, for `tsc -b`). Root tsconfig.json references the build config explicitly. This is not proper form, but a valid workaround.
