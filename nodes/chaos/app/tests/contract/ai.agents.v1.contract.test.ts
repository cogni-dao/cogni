// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/ai.agents.v1.contract`
 * Purpose: Validates agents list response matches ai.agents.v1 contract schema.
 * Scope: Tests Zod schema compliance for agents list response. Does not test API endpoint behavior.
 * Invariants:
 *   - LANGGRAPH_SERVER_ALIGNED: name required, description nullable
 * Side-effects: none
 * Links: @/contracts/ai.agents.v1.contract
 * @internal
 */

import {
  AgentDescriptorSchema,
  aiAgentsOperation,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("ai.agents.v1 contract validation", () => {
  it("accepts null description (LANGGRAPH_SERVER_ALIGNED)", () => {
    const valid = {
      agentId: "langgraph:poet",
      graphId: "langgraph:poet",
      name: "Poet",
      description: null,
    };
    expect(() => AgentDescriptorSchema.parse(valid)).not.toThrow();
  });

  it("rejects missing required fields", () => {
    const missing = { agentId: "langgraph:poet" };
    expect(() => AgentDescriptorSchema.parse(missing)).toThrow();
  });

  it("accepts null defaultAgentId in output", () => {
    const output = {
      agents: [],
      defaultAgentId: null,
    };
    expect(() => aiAgentsOperation.output.parse(output)).not.toThrow();
  });
});
