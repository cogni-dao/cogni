// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/langgraph/dev/agent-catalog.provider`
 * Purpose: Discovery-only provider for LangGraph dev catalog.
 * Scope: Implements AgentCatalogProvider for listing agents. Uses static LANGGRAPH_CATALOG in MVP. Does NOT call server for discovery.
 * Invariants:
 *   - STABLE_GRAPH_IDS: providerId = "langgraph" (same as InProc)
 *   - DISCOVERY_NO_EXECUTION_DEPS: No execution infrastructure required
 *   - P0_AGENT_GRAPH_IDENTITY: agentId === graphId
 *   - CATALOG_MANUAL_SYNC_P0: Reads from static catalog (same as InProc)
 * Side-effects: none
 * Notes: P1 will call /assistants/search for dynamic discovery
 * Links: LANGGRAPH_SERVER.md (MVP section), agent-catalog.provider.ts
 * @internal
 */

import { LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";

import type { AgentDescriptor } from "@/ports";

import type { AgentCatalogProvider } from "../../agent-catalog.provider";

/**
 * Provider ID for LangGraph.
 * Per STABLE_GRAPH_IDS: same as InProc provider.
 */
export const LANGGRAPH_PROVIDER_ID = "langgraph" as const;

/**
 * Discovery-only provider for LangGraph dev catalog.
 *
 * Per STABLE_GRAPH_IDS: providerId = "langgraph" (same as InProc).
 * Per DISCOVERY_NO_EXECUTION_DEPS: does not require execution infrastructure.
 * Per CATALOG_MANUAL_SYNC_P0: reads from static LANGGRAPH_CATALOG.
 *
 * MVP: Same implementation as LangGraphInProcAgentCatalogProvider.
 * P1: Will call /assistants/search for dynamic discovery from dev server.
 */
export class LangGraphDevAgentCatalogProvider implements AgentCatalogProvider {
  readonly providerId = LANGGRAPH_PROVIDER_ID;
  private readonly agentDescriptors: readonly AgentDescriptor[];

  constructor() {
    // Build descriptors from catalog at construction time
    this.agentDescriptors = this.buildDescriptors();
  }

  /**
   * Build agent descriptors from catalog entries.
   * Per P0_AGENT_GRAPH_IDENTITY: agentId === graphId.
   * Per LANGGRAPH_SERVER_ALIGNED: uses 'name' field (not displayName).
   */
  private buildDescriptors(): readonly AgentDescriptor[] {
    return Object.entries(LANGGRAPH_CATALOG).map(([graphName, entry]) => {
      const graphId = `${this.providerId}:${graphName}`;
      return {
        agentId: graphId, // P0: agentId === graphId
        graphId,
        name: entry.displayName, // LANGGRAPH_SERVER_ALIGNED: maps to 'name'
        description: entry.description,
      };
    });
  }

  /**
   * List all agents from catalog.
   */
  listAgents(): readonly AgentDescriptor[] {
    return this.agentDescriptors;
  }
}
