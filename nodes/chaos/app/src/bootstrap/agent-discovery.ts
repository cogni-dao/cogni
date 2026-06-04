// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/agent-discovery`
 * Purpose: Discovery-only factory for listing available agents.
 * Scope: Creates aggregator with discovery-only providers. No execution deps. Used by routes for agent listing. Does not create execution providers or require CompletionStreamFn.
 * Invariants:
 *   - DISCOVERY_NO_EXECUTION_DEPS: Does not require CompletionStreamFn or tool runners
 *   - DISCOVERY_PIPELINE: Route → this helper → aggregator → providers
 *   - REGISTRY_SEPARATION: Discovery providers only, never execution providers
 *   - P0_AGENT_GRAPH_IDENTITY: agentId === graphId (one agent per graph)
 * Side-effects: none
 * Links: AGENT_DISCOVERY.md, agent-catalog.port.ts
 * @public
 */

import {
  type AgentCatalogProvider,
  AggregatingAgentCatalog,
  LangGraphDevAgentCatalogProvider,
  LangGraphInProcAgentCatalogProvider,
} from "@/adapters/server";
import { SandboxAgentCatalogProvider } from "@/adapters/server/sandbox/sandbox-agent-catalog.provider";
import type { AgentDescriptor } from "@/ports";
import { serverEnv } from "@/shared/env";

/**
 * Create discovery-only aggregator.
 *
 * Per DISCOVERY_NO_EXECUTION_DEPS: This factory creates an aggregator
 * with discovery-only providers. It does NOT require CompletionStreamFn
 * or any execution infrastructure.
 *
 * Per REGISTRY_SEPARATION: Uses discovery-only providers (not execution providers).
 * Per MUTUAL_EXCLUSION: Register exactly one langgraph provider (InProc XOR Dev) based on env.
 *
 * @returns Aggregator that can list agents
 */
export function createAgentCatalog(): {
  listAgents(): readonly AgentDescriptor[];
} {
  // Per MUTUAL_EXCLUSION: choose provider based on LANGGRAPH_DEV_URL env
  const env = serverEnv();
  const providers: AgentCatalogProvider[] = env.LANGGRAPH_DEV_URL
    ? [new LangGraphDevAgentCatalogProvider()]
    : [new LangGraphInProcAgentCatalogProvider()];

  // Sandbox agents always registered — LITELLM_MASTER_KEY enforced by assertRuntimeSecrets()
  providers.push(new SandboxAgentCatalogProvider());

  return new AggregatingAgentCatalog(providers);
}

/**
 * List all available agents for API response.
 *
 * Per DISCOVERY_PIPELINE: Route calls this helper,
 * which uses aggregator to fan out to providers.
 *
 * @returns Array of agent descriptors sorted by name
 */
export function listAgentsForApi(): readonly AgentDescriptor[] {
  const catalog = createAgentCatalog();
  const agents = catalog.listAgents();

  // Sort by name for stable UI rendering
  return [...agents].sort((a, b) => a.name.localeCompare(b.name));
}
