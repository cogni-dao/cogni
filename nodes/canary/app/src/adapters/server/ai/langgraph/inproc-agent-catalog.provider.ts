// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/langgraph/inproc-agent-catalog.provider`
 * Purpose: Discovery-only provider for LangGraph in-proc catalog.
 * Scope: Implements AgentCatalogProvider for listing agents from static LANGGRAPH_CATALOG. Does NOT require execution infrastructure.
 * Invariants:
 *   - DISCOVERY_NO_EXECUTION_DEPS: No CompletionUnitAdapter or completion deps required
 *   - REGISTRY_SEPARATION: This provider is for discovery only, never execution
 *   - P0_AGENT_GRAPH_IDENTITY: agentId === graphId (one agent per graph)
 * Side-effects: none
 * Notes: P1 will add LangGraphServerAgentCatalogProvider calling /assistants/search
 * Links: AGENT_DISCOVERY.md, agent-catalog.provider.ts
 * @internal
 */

import { LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";

import type { AgentDescriptor } from "@/ports";

import type { AgentCatalogProvider } from "../agent-catalog.provider";

/**
 * LangGraph provider ID for namespacing.
 */
export const LANGGRAPH_PROVIDER_ID = "langgraph" as const;

/**
 * Discovery-only provider for LangGraph in-proc catalog.
 *
 * Per DISCOVERY_NO_EXECUTION_DEPS: this provider does not require
 * CompletionUnitAdapter or any execution infrastructure. It only
 * reads from the static LANGGRAPH_CATALOG.
 *
 * Per P0_AGENT_GRAPH_IDENTITY: agentId === graphId in P0.
 * Each catalog entry produces one agent where agentId equals the graphId.
 *
 * P1: LangGraphServerAgentCatalogProvider will call /assistants/search
 * for runtime discovery of assistants.
 */
export class LangGraphInProcAgentCatalogProvider
  implements AgentCatalogProvider
{
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
