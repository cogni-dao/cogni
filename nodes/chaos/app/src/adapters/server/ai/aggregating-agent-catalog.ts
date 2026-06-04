// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/aggregating-agent-catalog`
 * Purpose: Aggregates agent discovery across multiple catalog providers.
 * Scope: Implements AgentCatalogPort for unified agent listing. Does NOT handle execution.
 * Invariants:
 *   - DISCOVERY_NO_EXECUTION_DEPS: No execution infrastructure required
 *   - DISCOVERY_PIPELINE: Route → bootstrap → this → providers
 *   - P0_AGENT_GRAPH_IDENTITY: agentId === graphId (one agent per graph)
 * Side-effects: none (aggregates discovery results)
 * Links: AGENT_DISCOVERY.md, agent-catalog.provider.ts
 * @public
 */

import type { Logger } from "pino";

import type { AgentCatalogPort, AgentDescriptor } from "@/ports";
import { makeLogger } from "@/shared/observability";

import type { AgentCatalogProvider } from "./agent-catalog.provider";

/**
 * Aggregating agent catalog that fans out to multiple providers.
 *
 * Implements AgentCatalogPort for unified agent discovery.
 * Per DISCOVERY_NO_EXECUTION_DEPS: does not require execution infrastructure.
 */
export class AggregatingAgentCatalog implements AgentCatalogPort {
  private readonly log: Logger;
  private readonly providers: readonly AgentCatalogProvider[];

  /**
   * Create aggregating catalog with given providers.
   *
   * @param providers - Agent catalog providers to aggregate
   */
  constructor(providers: readonly AgentCatalogProvider[]) {
    this.providers = providers;
    this.log = makeLogger({ component: "AggregatingAgentCatalog" });

    // Log registered providers and their agents
    const agentCount = providers.reduce(
      (sum, p) => sum + p.listAgents().length,
      0
    );
    this.log.debug(
      {
        providerCount: providers.length,
        agentCount,
        providers: providers.map((p) => p.providerId),
      },
      "AggregatingAgentCatalog initialized"
    );
  }

  /**
   * List all available agents from all providers.
   * Used for discovery and UI agent selector.
   */
  listAgents(): readonly AgentDescriptor[] {
    return this.providers.flatMap((p) => p.listAgents());
  }
}
