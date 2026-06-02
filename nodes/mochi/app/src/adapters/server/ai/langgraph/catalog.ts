// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/langgraph/catalog`
 * Purpose: Type definitions for LangGraph catalog (graph factory registry).
 * Scope: Types only. Does NOT import from @cogni/langgraph-graphs/inproc — stable config surface.
 * Invariants:
 *   - CATALOG_DECOUPLED_FROM_EXECUTION_MODE: No inproc imports
 *   - CATALOG_VS_REGISTRY: Static collection built at bootstrap, not runtime registration
 *   - PROVIDER_SPECIFIC_CATALOG: Used only by LangGraphInProcProvider
 *   - TOOL_CATALOG_IS_CANONICAL: Tools referenced by ID, resolved from TOOL_CATALOG
 * Side-effects: none
 * Links: GRAPH_EXECUTION.md, LANGGRAPH_AI.md, inproc.provider.ts
 * @internal
 */

/**
 * Catalog entry for a LangGraph graph.
 *
 * Generic TFactory parameter is opaque at this layer — only the provider
 * interprets and binds the concrete factory type (e.g., CreateGraphFn).
 *
 * Per CATALOG_DECOUPLED_FROM_EXECUTION_MODE: this type does NOT depend on
 * @cogni/langgraph-graphs/inproc. Provider binds concrete type internally.
 *
 * Per TOOL_CATALOG_IS_CANONICAL: graphs reference tools by ID. Providers
 * resolve BoundTool instances from TOOL_CATALOG at runtime.
 */
export interface LangGraphCatalogEntry<TFactory> {
  /** Human-readable name for UI display */
  readonly displayName: string;
  /** Description of what this graph does */
  readonly description: string;
  /**
   * Tool IDs available to this graph.
   * Per TOOL_CATALOG_IS_CANONICAL: providers resolve BoundTool from TOOL_CATALOG.
   */
  readonly toolIds: readonly string[];
  /** Graph factory function (opaque — only provider interprets this) */
  readonly graphFactory: TFactory;
  /** Optional system prompt for operator graphs (catalog-driven, not hardcoded) */
  readonly systemPrompt?: string;
}

/**
 * LangGraph catalog type.
 *
 * Maps graph name (without provider prefix) to catalog entry.
 * e.g., { "poet": { ... }, "ponderer": { ... } }
 *
 * The full graphId is constructed as "${providerId}:${graphName}"
 * by the provider (e.g., "langgraph:poet").
 *
 * Per CATALOG_SINGLE_SOURCE_OF_TRUTH: the catalog instance is exported
 * from @cogni/langgraph-graphs, not built in bootstrap.
 */
export type LangGraphCatalog<TFactory> = Readonly<
  Record<string, LangGraphCatalogEntry<TFactory>>
>;
