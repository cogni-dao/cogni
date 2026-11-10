// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/agent.credentials.renew-v1.v1`
 * Purpose: Zod contract for POST /api/v1/agent/credentials/renew-v1.
 * Scope: Empty input (the bearer is the credential) and the renewed v1 key. Does not contain business logic.
 * Invariants: CONTRACTS_ARE_TRUTH; SAME_SUBJECT — userId equals the presented key's sub.
 * Side-effects: none
 * Links: task.5475, task.5474 (S0a key-rescue slice)
 * @public
 */

import { z } from "zod";

export const renewAgentV1Operation = {
  id: "agent.credentials.renew-v1.v1",
  input: z.object({}),
  output: z.object({
    userId: z.string().min(1),
    apiKey: z.string().min(1),
    expiresAt: z.string(),
    hardStop: z.string(),
  }),
} as const;
