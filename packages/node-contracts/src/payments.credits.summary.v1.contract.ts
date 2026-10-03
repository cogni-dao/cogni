// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/payments.credits.summary.v1.contract`
 * Purpose: Contract for fetching credits balance and ledger summary (widget payments).
 * Scope: Defines response schema for /api/v1/payments/credits/summary; does not resolve auth or persistence.
 * Invariants: Ledger entries ordered newest first; createdAt serialized as ISO string.
 * Side-effects: none
 * Notes: Billing account resolved from session on server.
 * Links: docs/spec/payments-design.md
 * @public
 */

import { z } from "zod";

const ledgerEntrySchema = z.object({
  id: z.string().uuid(),
  amount: z.number(),
  balanceAfter: z.number(),
  reason: z.string(),
  reference: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

export const creditsSummaryOperation = {
  id: "payments.credits.summary.v1",
  summary: "Fetch credits balance and ledger entries",
  description:
    "Returns billing account balance and recent credit ledger entries for the authenticated account.",
  input: z.object({
    limit: z.number().int().positive().max(100).optional(),
  }),
  output: z.object({
    billingAccountId: z.string(),
    // A balance CAN legitimately be negative: POST_CALL_NEVER_BLOCKS means a charge completes
    // even when it overdraws (billing-evolution.md invariant 6), so overage is reconciled, not
    // prevented. `.nonnegative()` made this route throw a ZodError on every poll once an account
    // went red, breaking the credits UI exactly when a user most needs to see it (bug.5266).
    balanceCredits: z.number(),
    ledger: z.array(ledgerEntrySchema),
  }),
} as const;

export type CreditsSummaryInput = z.infer<typeof creditsSummaryOperation.input>;
export type CreditsSummaryOutput = z.infer<
  typeof creditsSummaryOperation.output
>;
export type CreditsLedgerEntryDto = z.infer<typeof ledgerEntrySchema>;
