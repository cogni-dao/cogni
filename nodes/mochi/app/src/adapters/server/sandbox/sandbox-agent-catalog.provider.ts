// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/sandbox/sandbox-agent-catalog.provider`
 * Purpose: Discovery-only provider for sandbox agents.
 * Scope: Implements AgentCatalogProvider for listing sandbox agents in the UI. Does NOT require execution infrastructure.
 * Invariants:
 *   - DISCOVERY_NO_EXECUTION_DEPS: No SandboxRunnerAdapter or proxy deps required
 *   - P0_AGENT_GRAPH_IDENTITY: agentId === graphId (one agent per graph)
 * Side-effects: none
 * Links: docs/spec/sandboxed-agents.md, agent-catalog.provider.ts
 * @internal
 */

import type { AgentDescriptor } from "@/ports";

import type { AgentCatalogProvider } from "../ai/agent-catalog.provider";
import { SANDBOX_PROVIDER_ID } from "./sandbox-graph.provider";

const SANDBOX_AGENT_DESCRIPTORS: readonly AgentDescriptor[] = [
  {
    agentId: `${SANDBOX_PROVIDER_ID}:agent`,
    graphId: `${SANDBOX_PROVIDER_ID}:agent`,
    name: "Sandbox Agent",
    description:
      "LLM agent running in isolated container (network=none, LLM via proxy)",
  },
  {
    agentId: `${SANDBOX_PROVIDER_ID}:openclaw`,
    graphId: `${SANDBOX_PROVIDER_ID}:openclaw`,
    name: "OpenClaw",
    description: "Community-accessible OpenClaw container agent",
  },
];

/**
 * Discovery-only provider for sandbox agents.
 *
 * Per SANDBOXED_AGENTS.md P0.75: lists sandbox agents so the UI
 * agent selector can offer them. Registration is gated by
 * LITELLM_MASTER_KEY presence in bootstrap.
 */
export class SandboxAgentCatalogProvider implements AgentCatalogProvider {
  readonly providerId = SANDBOX_PROVIDER_ID;

  listAgents(): readonly AgentDescriptor[] {
    return SANDBOX_AGENT_DESCRIPTORS;
  }
}
