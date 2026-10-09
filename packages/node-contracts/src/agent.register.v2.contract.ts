// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/agent.register.v2`
 * Purpose: Contract for one-use spawn-grant redemption at POST /api/v1/agent/register.
 * Scope: Input (spawn token) and output (node-local credential plus durable actor identity).
 * Invariants: SPAWNED_ONLY; CREDENTIAL_NE_PRINCIPAL; NODE_LOCAL_BEARER.
 * Side-effects: none
 * Links: task.5211, task.5217
 * @public
 */

import { z } from "zod";

export const registerAgentV2Operation = {
  id: "agent.register.v2",
  input: z.object({
    spawnToken: z.string().min(32).max(512),
  }),
  output: z.object({
    actorId: z.string().uuid(),
    principalId: z.string().startsWith("agent:"),
    credentialId: z.string().uuid(),
    apiKey: z.string().min(1),
    billingAccountId: z.string().min(1),
    authenticateUntil: z.string().datetime(),
    renewUntil: z.string().datetime(),
  }),
} as const;
