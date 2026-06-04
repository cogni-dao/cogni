// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/services/creditsSummary`
 * Purpose: Provide credit balance and ledger summaries for widget payments page.
 * Scope: Feature-layer aggregation of account balance and recent ledger entries; does not handle HTTP parsing or session resolution.
 * Invariants: Returns ledger entries ordered by newest first; relies on AccountService for data access.
 * Side-effects: IO (via AccountService port).
 * Notes: Does not perform authentication; billing account resolution handled by app layer.
 * Links: docs/spec/payments-design.md
 * @public
 */

import type { AccountService, CreditLedgerEntry } from "@/ports";

const DEFAULT_LEDGER_LIMIT = 20;

export interface CreditsSummaryInput {
  billingAccountId: string;
  limit?: number | undefined;
  reason?: string | undefined;
}

export interface CreditsSummaryResult {
  billingAccountId: string;
  balanceCredits: number;
  ledger: CreditLedgerEntry[];
}

export async function getCreditsSummary(
  accountService: AccountService,
  input: CreditsSummaryInput
): Promise<CreditsSummaryResult> {
  const limit = input.limit ?? DEFAULT_LEDGER_LIMIT;
  const listParams: Parameters<AccountService["listCreditLedgerEntries"]>[0] =
    input.reason
      ? {
          billingAccountId: input.billingAccountId,
          limit,
          reason: input.reason,
        }
      : {
          billingAccountId: input.billingAccountId,
          limit,
        };

  const [balanceCredits, ledger] = await Promise.all([
    accountService.getBalance(input.billingAccountId),
    accountService.listCreditLedgerEntries(listParams),
  ]);

  return {
    billingAccountId: input.billingAccountId,
    balanceCredits,
    ledger,
  };
}
