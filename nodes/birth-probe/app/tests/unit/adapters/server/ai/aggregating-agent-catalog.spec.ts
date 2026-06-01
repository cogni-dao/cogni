// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/aggregating-agent-catalog`
 * Purpose: Unit tests for AggregatingAgentCatalog discovery aggregation.
 * Scope: Verifies listAgents aggregation from multiple providers. Does NOT test execution.
 * Invariants:
 *   - DISCOVERY_NO_EXECUTION_DEPS: Catalog does not require execution infrastructure
 *   - P0_AGENT_GRAPH_IDENTITY: agentId === graphId
 * Side-effects: none
 * Links: aggregating-agent-catalog.ts, AGENT_DISCOVERY.md
 * @public
 */

import { createMockAgentCatalogProvider } from "@tests/_fixtures/ai/fixtures";
import { describe, expect, it } from "vitest";
import { AggregatingAgentCatalog } from "@/adapters/server/ai/aggregating-agent-catalog";

describe("AggregatingAgentCatalog", () => {
  describe("listAgents", () => {
    it("aggregates agents from all providers", () => {
      const provider1 = createMockAgentCatalogProvider("langgraph", [
        "poet",
        "research",
      ]);
      const provider2 = createMockAgentCatalogProvider("claude_sdk", [
        "planner",
      ]);
      const catalog = new AggregatingAgentCatalog([provider1, provider2]);

      const agents = catalog.listAgents();

      expect(agents).toHaveLength(3);
      expect(agents.map((a) => a.agentId)).toEqual([
        "langgraph:poet",
        "langgraph:research",
        "claude_sdk:planner",
      ]);
    });

    it("returns empty array when no providers registered", () => {
      const catalog = new AggregatingAgentCatalog([]);

      const agents = catalog.listAgents();

      expect(agents).toHaveLength(0);
    });

    it("includes both agentId and graphId in descriptors (P0: equal)", () => {
      const provider = createMockAgentCatalogProvider("langgraph", ["poet"]);
      const catalog = new AggregatingAgentCatalog([provider]);

      const agents = catalog.listAgents();

      expect(agents).toHaveLength(1);
      expect(agents[0].agentId).toBe("langgraph:poet");
      expect(agents[0].graphId).toBe("langgraph:poet");
      expect(agents[0].agentId).toBe(agents[0].graphId); // P0 invariant
    });

    it("includes name and description in agent descriptors (LANGGRAPH_SERVER_ALIGNED)", () => {
      const provider = createMockAgentCatalogProvider("langgraph", ["poet"]);
      const catalog = new AggregatingAgentCatalog([provider]);

      const agents = catalog.listAgents();

      expect(agents[0].name).toBe("Poet");
      expect(agents[0].description).toBe("Test poet agent");
    });
  });
});
