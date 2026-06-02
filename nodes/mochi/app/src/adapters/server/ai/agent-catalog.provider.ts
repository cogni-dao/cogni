// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/agent-catalog.provider`
 * Purpose: Internal interface for agent catalog providers.
 * Scope: Defines provider contract for AggregatingAgentCatalog. NOT a public port in P0.
 * Invariants:
 *   - DISCOVERY_SEPARATION: AggregatingAgentCatalog fans out discovery to AgentCatalogProvider[]
 *   - DISCOVERY_NO_EXECUTION_DEPS: Providers do not require execution infrastructure
 *   - P0_AGENT_GRAPH_IDENTITY: agentId === graphId (one agent per graph)
 * Side-effects: none
 * Links: AGENT_DISCOVERY.md, aggregating-agent-catalog.ts
 * @internal
 */

import type { AgentDescriptor } from "@/ports";

// Re-export port types for provider implementations
export type { AgentDescriptor } from "@/ports";

/**
 * Internal interface for agent catalog providers.
 *
 * NOT a public port in P0 — stays in adapters layer.
 * AggregatingAgentCatalog fans out to providers for discovery.
 *
 * Per DISCOVERY_NO_EXECUTION_DEPS: providers do not require CompletionStreamFn
 * or any execution infrastructure.
 *
 * Per DISCOVERY_SEPARATION: discovery is pure listAgents() fanout, no routing.
 */
export interface AgentCatalogProvider {
  /** Provider identifier (e.g., "langgraph", "claude_sdk") */
  readonly providerId: string;

  /**
   * List all agents available from this provider.
   * Used for discovery and UI agent selector.
   */
  listAgents(): readonly AgentDescriptor[];
}
