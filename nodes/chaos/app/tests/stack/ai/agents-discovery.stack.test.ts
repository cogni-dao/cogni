// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/agents-discovery.stack`
 * Purpose: Verify GET /api/v1/ai/agents returns valid agent list.
 * Scope: Tests auth-protected agents route with mocked session. Does not test internal catalog logic.
 * Invariants:
 *   - P0_AGENT_GRAPH_IDENTITY: agentId === graphId for all agents
 *   - LANGGRAPH_SERVER_ALIGNED: response shape matches contract
 * Side-effects: IO
 * Links: /api/v1/ai/agents, AGENT_DISCOVERY.md
 * @public
 */

import { randomUUID } from "node:crypto";
import { aiAgentsOperation } from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { NextRequest } from "next/server";
import { expect, test, vi } from "vitest";
import { getSessionUser } from "@/app/_lib/auth/session";
import { GET as agentsGET } from "@/app/api/v1/ai/agents/route";

// Mock session
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

test("[ai] GET /api/v1/ai/agents returns valid response", async () => {
  // Arrange - Mock authenticated user
  const mockSessionUser: SessionUser = {
    id: randomUUID(),
    walletAddress: `0x${randomUUID().replace(/-/g, "").substring(0, 40)}`,
  };
  vi.mocked(getSessionUser).mockResolvedValue(mockSessionUser);

  // Act - Call route handler directly
  const request = new NextRequest("http://localhost:3000/api/v1/ai/agents");
  const response = await agentsGET(request);

  // Assert - Response shape
  expect(response.status).toBe(200);

  const body = await response.json();
  const parsed = aiAgentsOperation.output.safeParse(body);
  expect(parsed.success).toBe(true);

  if (parsed.success) {
    // P0_AGENT_GRAPH_IDENTITY: agentId === graphId
    for (const agent of parsed.data.agents) {
      expect(agent.agentId).toBe(agent.graphId);
      expect(agent.name).toBeTruthy();
      expect(
        agent.description === null || typeof agent.description === "string"
      ).toBe(true);
    }

    // defaultAgentId must exist in agents list if not null
    if (parsed.data.defaultAgentId !== null) {
      const agentIds = parsed.data.agents.map((a) => a.agentId);
      expect(agentIds).toContain(parsed.data.defaultAgentId);
    }
  }
});
