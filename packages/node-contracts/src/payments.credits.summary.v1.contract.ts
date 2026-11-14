// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/payments.credits.summary.v1.contract`
 * Purpose: Contract for fetching credits balance and ledger summary (widget payments).
 * Scope: Defines response schema for /api/v1/payments/credits/summary; does not resolve auth or persistence.
 * Invariants: Ledger entries ordered newest first; createdAt serialized as ISO string.
 * Side-effects: none
 * Notes: Billing account resolved from session on server.
 * Links: https://node-template.cognidao.org/knowledge/payments-usdc-verification-design
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
    balanceCredits: z.number().nonnegative(),
    ledger: z.array(ledgerEntrySchema),
  }),
} as const;

export type CreditsSummaryInput = z.infer<typeof creditsSummaryOperation.input>;
export type CreditsSummaryOutput = z.infer<
  typeof creditsSummaryOperation.output
>;
export type CreditsLedgerEntryDto = z.infer<typeof ledgerEntrySchema>;
