// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/ai/agents`
 * Purpose: Provides HTTP endpoint for listing available agents.
 * Scope: Auth-protected GET endpoint that returns agent descriptors with catalog-defined default. Does not implement agent discovery logic.
 * Invariants:
 *   - DISCOVERY_PIPELINE: Route → listAgentsForApi() → aggregator → providers
 *   - UI_ONLY_TALKS_TO_PORT: Returns stable agentIds regardless of execution backend
 *   - P0_AGENT_GRAPH_IDENTITY: agentId === graphId (one agent per graph)
 * Side-effects: IO (HTTP request/response)
 * Notes: Implements SEC-001 (auth-protected). Uses discovery pipeline via bootstrap helper.
 * Links: ai.agents.v1.contract, AGENT_DISCOVERY.md
 * @public
 */

// P0: Default comes from package; P1: app-configurable via env
import { DEFAULT_LANGGRAPH_GRAPH_ID } from "@cogni/langgraph-graphs";
import { aiAgentsOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { listAgentsForApi } from "@/bootstrap/agent-discovery";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "ai.agents", auth: { mode: "required", getSessionUser } },
  async (ctx) => {
    const startMs = performance.now();
    try {
      // Per DISCOVERY_PIPELINE: Use bootstrap helper, not direct catalog import
      const agents = listAgentsForApi();

      // P0: Default from package constant (agentId === graphId in P0)
      // P1: app-configurable via env
      const defaultAgentId = agents.some(
        (a) => a.agentId === DEFAULT_LANGGRAPH_GRAPH_ID
      )
        ? DEFAULT_LANGGRAPH_GRAPH_ID
        : null;

      if (defaultAgentId === null && agents.length > 0) {
        ctx.log.warn(
          { expected: DEFAULT_LANGGRAPH_GRAPH_ID, agentCount: agents.length },
          "Catalog default agent not found in agent list"
        );
      }

      // Validate with contract before returning
      const payload = { agents: [...agents], defaultAgentId };
      const parseResult = aiAgentsOperation.output.safeParse(payload);

      if (!parseResult.success) {
        ctx.log.error(
          {
            errCode: "inv_agents_contract_validation_failed",
            agentCount: agents.length,
          },
          "Agent data failed contract validation"
        );
        return NextResponse.json(
          { error: "Server error: invalid data format" },
          { status: 500 }
        );
      }

      ctx.log.info(
        {
          agentCount: agents.length,
          defaultAgentId,
          durationMs: performance.now() - startMs,
        },
        "ai.agents_list_success"
      );

      return NextResponse.json(parseResult.data, { status: 200 });
    } catch (error) {
      ctx.log.error(
        {
          errCode: "ai.agents_list_failed",
          errorType: error instanceof Error ? error.name : "unknown",
        },
        "Failed to list agents"
      );
      return NextResponse.json(
        { error: "Failed to list agents" },
        { status: 500 }
      );
    }
  }
);
