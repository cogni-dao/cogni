// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/services/creditsConfirm`
 * Purpose: Confirm widget payments by crediting user billing account and minting system tenant bonus.
 * Scope: Feature-layer orchestration for payment confirmations and revenue share; does not expose HTTP handling or session resolution.
 * Invariants: Credits via usdCentsToCredits (integer math); idempotent on clientPaymentId; system tenant bonus sequential + idempotent.
 * Side-effects: IO (via AccountService and ServiceAccountService ports).
 * Notes: Billing account resolved at app layer. Reads SYSTEM_TENANT_REVENUE_SHARE from env (llmPricingPolicy pattern).
 * Links: docs/spec/payments-design.md, docs/spec/system-tenant.md, src/core/billing/pricing.ts
 * @public
 */

import {
  calculateRevenueShareBonus,
  usdCentsToCredits,
} from "@cogni/node-core";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  PLATFORM_REVENUE_SHARE_REASON,
  WIDGET_PAYMENT_REASON,
} from "@cogni/node-shared";
import type { AccountService, ServiceAccountService } from "@/ports";
import { serverEnv } from "@/shared/env";

export interface CreditsConfirmInput {
  billingAccountId: string;
  defaultVirtualKeyId: string;
  amountUsdCents: number;
  clientPaymentId: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface CreditsConfirmResult {
  billingAccountId: string;
  balanceCredits: number;
  creditsApplied: number;
}

export async function confirmCreditsPayment(
  accountService: AccountService,
  serviceAccountService: ServiceAccountService,
  input: CreditsConfirmInput
): Promise<CreditsConfirmResult> {
  const existingEntry = await accountService.findCreditLedgerEntryByReference({
    billingAccountId: input.billingAccountId,
    reason: WIDGET_PAYMENT_REASON,
    reference: input.clientPaymentId,
  });

  if (existingEntry) {
    return {
      billingAccountId: input.billingAccountId,
      balanceCredits: existingEntry.balanceAfter,
      creditsApplied: 0,
    };
  }

  if (input.amountUsdCents <= 0) {
    throw new Error("amountUsdCents must be greater than zero");
  }

  // Convert cents to credits using integer math (no float division)
  const creditsAsBigInt = usdCentsToCredits(input.amountUsdCents);
  // TODO: Move ledger ports to bigint; for now convert to number
  const credits = Number(creditsAsBigInt);
  const metadata = {
    provider: "depay",
    amountUsdCents: input.amountUsdCents,
    ...(input.metadata ?? {}),
  };

  // Step 1: Credit the user (appDb, RLS-scoped)
  const { newBalance } = await accountService.creditAccount({
    billingAccountId: input.billingAccountId,
    amount: credits,
    reason: WIDGET_PAYMENT_REASON,
    reference: input.clientPaymentId,
    virtualKeyId: input.defaultVirtualKeyId,
    metadata,
  });

  // Step 2: Mint bonus credits to system tenant (serviceDb, BYPASSRLS)
  // Sequential + idempotent — separate DB connection, not one transaction.
  // If crash between steps: retry skips user credit (idempotent), applies system tenant credit.
  const bonusCredits = calculateRevenueShareBonus(
    creditsAsBigInt,
    serverEnv().SYSTEM_TENANT_REVENUE_SHARE
  );

  if (bonusCredits > 0n) {
    const existingBonus =
      await serviceAccountService.findCreditLedgerEntryByReference({
        billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
        reason: PLATFORM_REVENUE_SHARE_REASON,
        reference: input.clientPaymentId,
      });

    if (!existingBonus) {
      await serviceAccountService.creditAccount({
        billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
        amount: Number(bonusCredits),
        reason: PLATFORM_REVENUE_SHARE_REASON,
        reference: input.clientPaymentId,
      });
    }
  }

  return {
    billingAccountId: input.billingAccountId,
    balanceCredits: newBalance,
    creditsApplied: credits,
  };
}
