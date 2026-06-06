// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/agent-catalog`
 * Purpose: Port interface for agent discovery (listing available agents).
 * Scope: Defines AgentCatalogPort contract for discovery-only operations. Does not handle execution.
 * Invariants:
 *   - DISCOVERY_NO_EXECUTION_DEPS: Discovery does not require execution infrastructure
 *   - P0_AGENT_GRAPH_IDENTITY: agentId === graphId (one agent per graph)
 *   - UI_ONLY_TALKS_TO_PORT: UI calls listAgents() via port; does not know providers
 *   - LANGGRAPH_SERVER_ALIGNED: Field names match LangGraph Server assistant model
 * Side-effects: none (interface only)
 * Links: AGENT_DISCOVERY.md, ai.agents.v1.contract.ts
 * @public
 */

/**
 * Agent descriptor for discovery and UI display.
 * Returned by AgentCatalogPort.listAgents().
 *
 * Per P0_AGENT_GRAPH_IDENTITY: agentId === graphId in P0.
 * P1+: agentId becomes stable and may reference multiple assistants per graph.
 *
 * Per LANGGRAPH_SERVER_ALIGNED: field names match LangGraph Server assistant model.
 * - name (not displayName) matches LangGraph Server
 * - description is nullable (LangGraph Server allows null)
 *
 * graphId format is "${providerId}:${graphName}" (e.g., "langgraph:poet").
 * For providerId='langgraph', the suffix after ':' maps to LangGraph Server graph_id.
 */
export interface AgentDescriptor {
  /**
   * Stable agent identifier.
   * P0: equals graphId (one agent per graph).
   * P1+: stable across assistant variants.
   */
  readonly agentId: string;
  /**
   * Internal graph reference for routing.
   * Format: "${providerId}:${graphName}" (e.g., "langgraph:poet").
   * For providerId='langgraph', suffix after ':' maps to LangGraph Server graph_id.
   */
  readonly graphId: string;
  /** Human-readable name (matches LangGraph Server 'name' field) */
  readonly name: string;
  /** Description of what this agent does (nullable per LangGraph Server) */
  readonly description: string | null;
}

/**
 * Port interface for agent discovery.
 *
 * Per DISCOVERY_NO_EXECUTION_DEPS: discovery is decoupled from execution.
 * Implementations do not require CompletionStreamFn or execution infrastructure.
 *
 * Per UI_ONLY_TALKS_TO_PORT: UI calls this port; does not know providers.
 */
export interface AgentCatalogPort {
  /**
   * List all available agents from all providers.
   * Used for discovery and UI agent selector.
   *
   * @returns Array of agent descriptors
   */
  listAgents(): readonly AgentDescriptor[];
}
