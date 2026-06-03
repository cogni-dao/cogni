// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs`
 * Purpose: Barrel export for LangGraph graph definitions and runtime utilities.
 * Scope: Re-exports public types. All @langchain/* code lives here (per NO_LANGCHAIN_IN_SRC). Does not contain implementation logic.
 * Invariants:
 *   - SINGLE_SOURCE_OF_TRUTH: These are the canonical LangGraph definitions
 *   - NO_LANGCHAIN_IN_SRC: Only this package imports @langchain/*
 *   - PACKAGES_NO_SRC_IMPORTS: Never import from src/
 * Side-effects: none
 * Links: LANGGRAPH_AI.md, GRAPH_EXECUTION.md
 * @public
 */

// Re-export catalog (single source of truth for graph definitions)
export {
  DEFAULT_LANGGRAPH_GRAPH_ID,
  LANGGRAPH_CATALOG,
  LANGGRAPH_GRAPH_IDS,
  LANGGRAPH_PROVIDER_ID,
  type LangGraphCatalogKeys,
  type LangGraphGraphId,
} from "./catalog";

// Re-export graph constants and factories
export {
  AUTORESEARCH_REGISTRY_SWARM_GRAPH_NAME,
  AUTORESEARCH_SINGLE_LANE_GRAPH_NAME,
  AUTORESEARCH_SYNTROPY_LOOP_GRAPH_NAME,
  BRAIN_GRAPH_NAME,
  POET_GRAPH_NAME,
} from "./graphs/index";

// Re-export inproc runner (all LangChain logic contained in package)
export { createInProcGraphRunner } from "./inproc/runner";

// Re-export inproc types for provider to use
export type {
  CompletionFn,
  CompletionResult,
  CreateGraphFn,
  GraphResult,
  InProcGraphRequest,
  InProcRunnerOptions,
  Message,
  ToolExecFn,
  ToolExecResult,
} from "./inproc/types";

// Re-export runtime types (interfaces only, not implementations)
export type { MakeLangChainToolOptions } from "./runtime/index";
export type { McpServerConfig, McpServersConfig } from "./runtime/mcp/index";
// Re-export MCP client utilities + tool source
export {
  loadMcpTools,
  McpToolSource,
  parseMcpConfigFromEnv,
} from "./runtime/mcp/index";
