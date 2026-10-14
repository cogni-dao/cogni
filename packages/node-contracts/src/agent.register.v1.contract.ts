// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/agent.register.v1`
 * Purpose: Zod contract for POST /api/v1/agent/register.
 * Scope: Input (agent display name) and output (issued machine credentials + actor identity). Does not contain business logic.
 * Invariants: CONTRACTS_ARE_TRUTH — single source for registration wire shape.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/human-ai-identity-standard, docs/spec/node-operator-contract.md
 * @public
 */

import { z } from "zod";

export const registerAgentOperation = {
  id: "agent.register.v1",
  input: z.object({
    name: z.string().min(1).max(80),
  }),
  output: z.object({
    userId: z.string().min(1),
    apiKey: z.string().min(1),
    billingAccountId: z.string().min(1),
  }),
} as const;
