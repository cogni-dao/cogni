// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/agent-account-access.v1`
 * Purpose: Public contracts for human-governed agent account grants and exact-account reads.
 * Scope: Strict wire validation only; identity and authorization stay server-derived.
 * Invariants: HUMAN_GRANTOR_FROM_SESSION; SUBJECT_NOT_CALLER_SUPPLIED; EXACT_ACCOUNT_ONLY.
 * Side-effects: none
 * Links: task.5263, docs/spec/rbac.md
 * @public
 */

import { z } from "zod";

const LocalIdSchema = z.string().uuid();

export const mutateAgentAccountAccessOperation = {
  id: "accounts.agent-access.mutate.v1",
  input: z.discriminatedUnion("operation", [
    z.strictObject({
      operation: z.literal("grant"),
      agentActorId: LocalIdSchema,
      mode: z.enum(["direct", "on_behalf_of"]),
      expiresAt: z.string().datetime(),
    }),
    z.strictObject({
      operation: z.literal("revoke"),
      agentActorId: LocalIdSchema,
      mode: z.enum(["direct", "on_behalf_of"]),
    }),
  ]),
  output: z.strictObject({
    billingAccountId: LocalIdSchema,
    agentActorId: LocalIdSchema,
    mode: z.enum(["direct", "on_behalf_of"]),
    operation: z.enum(["grant", "revoke"]),
  }),
} as const;

export const readAgentBillingAccountOperation = {
  id: "accounts.agent-readable.read.v1",
  input: z.strictObject({ billingAccountId: LocalIdSchema }),
  output: z.strictObject({
    billingAccountId: LocalIdSchema,
    balanceCredits: z.number(),
    accessMode: z.enum(["direct", "on_behalf_of"]),
  }),
} as const;
