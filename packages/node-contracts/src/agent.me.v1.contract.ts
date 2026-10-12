// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/agent.me.v1.contract`
 * Purpose: Contract for the agent self-identity endpoint (`GET /api/v1/agent/me`).
 * Scope: Defines the response schema an authenticated caller gets back about
 *   ITSELF — principal id, display name, and (for agent API keys) the key's
 *   expiry. Does not enumerate RBAC grants and performs no authorization I/O.
 * Invariants: Returns only the CALLER's own principal (never another user's).
 *   A `200` proves the credential is live; a `401` proves it is expired/invalid
 *   — the unambiguous liveness signal that `/users/me` (session-cookie only)
 *   cannot give an agent key.
 * Side-effects: none
 * Links: /api/v1/agent/me route, agent.register.v1.contract, /api/v1/cognition
 * @public
 */

import { z } from "zod";

export const agentMeOutputSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  /** `agent` when authenticated by an agent API key, `session` for a cookie. */
  principal: z.enum(["agent", "session"]),
  /** ISO-8601 expiry of the agent key; null for cookie sessions. */
  expiresAt: z.string().nullable(),
  /** Seconds until the agent key expires; null for cookie sessions. */
  expiresInSeconds: z.number().nullable(),
});

export type AgentMeOutput = z.infer<typeof agentMeOutputSchema>;

export const agentMeOperation = {
  id: "agent.me.v1",
  summary: "Authenticated caller's own identity + key liveness",
  description:
    "Returns the calling principal's userId, displayName, and — for agent API keys — the key's expiry. A 200 means the credential is live; a 401 means it is genuinely expired or invalid.",
  input: null,
  output: agentMeOutputSchema,
} as const;
