// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/agent-identity`
 * Purpose: Re-export the portable target-node AI identity boundary for operator consumers.
 * Scope: Compatibility barrel only; never implements identity, credentials, permissions, or persistence.
 * Invariants: ONE_SHARED_PORT; TARGET_NODE_OWNS_IDENTITY.
 * Side-effects: none
 * Links: @cogni/node-contracts/agent.identity.port, story.5075
 * @public
 */
export {
  type AgentCredentialAccess,
  type AgentCredentialMaterial,
  type AgentCredentialStatus,
  AgentIdentityError,
  type AgentIdentityPort,
  type LegacyAgentUpgrade,
} from "@cogni/node-contracts";
