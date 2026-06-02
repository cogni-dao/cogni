// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/application/confirmCreditsPurchase`
 * Purpose: Application orchestrator — composes credit confirmation with treasury settlement, TigerBeetle co-writes, and provider funding.
 * Scope: Orchestrates the full credit purchase chain: credit user → settle treasury → record USDC movements in TB → top up provider.
 *   Steps 1-2 (credits) always succeed independently. Steps 3-6 (settlement, TB, funding) are non-blocking — log critical on failure.
 *   `runPostCreditFunding` is extracted so both the widget path (confirmCreditsPurchase) and on-chain path (verifyAndSettle) can invoke post-credit steps.
 * Invariants:
 *   - Credit confirmation always succeeds independently of downstream steps
 *   - Settlement and funding skipped on idempotent replay
 *   - SETTLEMENT_NON_BLOCKING: Steps 3-6 never fail the user response
 *   - CO_WRITE_NON_BLOCKING: TigerBeetle writes fire-and-forget
 *   - ASSET_SWAP_NOT_EXPENSE: Top-up posts OperatorFloat → ProviderFloat
 * Side-effects: IO (via delegated ports)
 * Links: docs/spec/financial-ledger.md, task.0086
 * @public
 */

import type { FinancialLedgerPort } from "@cogni/financial-ledger";
import {
  ACCOUNT,
  LEDGER,
  TB_TRANSFER_NAMESPACE,
  TRANSFER_CODE,
  USDC_SCALE,
  uuidToBigInt,
} from "@cogni/financial-ledger";
import { calculateOpenRouterTopUp } from "@cogni/node-core";
import type { Logger } from "pino";
import { v5 as uuidv5 } from "uuid";
import {
  type CreditsConfirmInput,
  confirmCreditsPayment,
} from "@/features/payments/services/creditsConfirm";
import type {
  AccountService,
  ProviderFundingPort,
  ServiceAccountService,
  TreasurySettlementOutcome,
  TreasurySettlementPort,
} from "@/ports";

export type { CreditsConfirmInput } from "@/features/payments/services/creditsConfirm";

export interface ConfirmCreditsPurchaseDeps {
  accountService: AccountService;
  serviceAccountService: ServiceAccountService;
  treasurySettlement: TreasurySettlementPort | undefined;
  financialLedger: FinancialLedgerPort | undefined;
  providerFunding: ProviderFundingPort | undefined;
  log: Logger;
  /** Pricing config for provider top-up calculation. Required when providerFunding is set. */
  pricingConfig?:
    | {
        markupFactor: number;
        revenueShare: number;
        cryptoFee: number;
      }
    | undefined;
}

export interface ConfirmCreditsPurchaseResult {
  billingAccountId: string;
  balanceCredits: number;
  creditsApplied: number;
  /** Present when on-chain treasury settlement succeeded */
  settlement?: TreasurySettlementOutcome;
  /** Present when treasury settlement was attempted but failed */
  settlementError?: unknown;
}

// ---------------------------------------------------------------------------
// Post-credit funding (steps 3-6) — extracted for reuse by on-chain path
// ---------------------------------------------------------------------------

export interface PostCreditFundingDeps {
  treasurySettlement: TreasurySettlementPort | undefined;
  financialLedger: FinancialLedgerPort | undefined;
  providerFunding: ProviderFundingPort | undefined;
  log: Logger;
  /** Pricing config for provider top-up calculation. Required when providerFunding is set. */
  pricingConfig?:
    | {
        markupFactor: number;
        revenueShare: number;
        cryptoFee: number;
      }
    | undefined;
}

export interface PostCreditFundingResult {
  /** Present when on-chain treasury settlement succeeded */
  settlement?: TreasurySettlementOutcome;
  /** Present when treasury settlement was attempted but failed */
  settlementError?: unknown;
}

/**
 * Generate a deterministic TigerBeetle transfer ID from paymentIntentId + step code.
 * Uses uuid v5 (SHA-1 namespace) → u128 bigint. Idempotent on retry.
 */
function deterministicTransferId(
  paymentIntentId: string,
  stepCode: number
): bigint {
  const uuid = uuidv5(`${paymentIntentId}:${stepCode}`, TB_TRANSFER_NAMESPACE);
  return uuidToBigInt(uuid);
}

/**
 * Confirm a credit purchase and run the full settlement + funding chain.
 *
 * Steps 1-2 (credit user + mint system tenant bonus) delegate to confirmCreditsPayment.
 * Step 3 (treasury settlement) delegates to TreasurySettlementPort.
 * Step 4 (TB co-write: Split distribute) records Treasury → OperatorFloat in TigerBeetle.
 * Step 5 (provider funding) delegates to ProviderFundingPort.
 * Step 6 (TB co-write: provider top-up) records OperatorFloat → ProviderFloat in TigerBeetle.
 *
 * Steps 3-6 are non-blocking — log critical on failure, never fail user response.
 */
export async function confirmCreditsPurchase(
  deps: ConfirmCreditsPurchaseDeps,
  input: CreditsConfirmInput
): Promise<ConfirmCreditsPurchaseResult> {
  // Steps 1-2: Credit user + mint system tenant bonus
  const result = await confirmCreditsPayment(
    deps.accountService,
    deps.serviceAccountService,
    input
  );

  // Skip settlement on idempotent replay (duplicate payment)
  if (result.creditsApplied === 0) return result;

  // Steps 3-6: post-credit funding chain (treasury settlement, TB co-writes, provider top-up)
  const fundingResult = await runPostCreditFunding(deps, {
    paymentIntentId: input.clientPaymentId,
    amountUsdCents: input.amountUsdCents,
  });

  return {
    ...result,
    ...fundingResult,
  };
}

/**
 * Run post-credit funding chain (steps 3-6).
 *
 * Step 3: Treasury settlement — call Split distribute via TreasurySettlementPort.
 * Step 4: TB co-write — record Split distribute (Treasury → OperatorFloat).
 * Step 5: Provider funding — top up OpenRouter via ProviderFundingPort.
 * Step 6: TB co-write — record provider top-up (OperatorFloat → ProviderFloat).
 *
 * All steps are non-blocking — log critical on failure, never throw.
 * Called by both the widget path (confirmCreditsPurchase) and on-chain path (verifyAndSettle).
 */
export async function runPostCreditFunding(
  deps: PostCreditFundingDeps,
  input: { paymentIntentId: string; amountUsdCents: number }
): Promise<PostCreditFundingResult> {
  const { log } = deps;
  const { paymentIntentId, amountUsdCents } = input;

  // Step 3: Settle treasury revenue (Split distribute)
  let settlement: TreasurySettlementOutcome | undefined;
  let settlementError: unknown;
  if (deps.treasurySettlement) {
    try {
      settlement = await deps.treasurySettlement.settleConfirmedCreditPurchase({
        paymentIntentId,
      });
    } catch (err) {
      settlementError = err;
      log.error(
        { err, paymentIntentId },
        "treasury settlement failed — credits confirmed, settlement skipped"
      );
    }
  }

  // Step 4: TB co-write — record Split distribute (Treasury → OperatorFloat)
  if (deps.financialLedger && settlement) {
    try {
      // cents × 10_000 = micro-USDC (all-bigint, no float rounding)
      const amountMicroUsdc = BigInt(amountUsdCents) * (USDC_SCALE / 100n);
      await deps.financialLedger.transfer({
        id: deterministicTransferId(
          paymentIntentId,
          TRANSFER_CODE.SPLIT_DISTRIBUTE
        ),
        debitAccountId: ACCOUNT.ASSETS_TREASURY,
        creditAccountId: ACCOUNT.ASSETS_OPERATOR_FLOAT,
        amount: amountMicroUsdc,
        ledger: LEDGER.USDC,
        code: TRANSFER_CODE.SPLIT_DISTRIBUTE,
      });
    } catch (err) {
      log.error(
        { err, paymentIntentId },
        "TB co-write failed for Split distribute — continuing"
      );
    }
  }

  // Step 5: Provider funding (OpenRouter top-up)
  if (deps.providerFunding && !deps.pricingConfig) {
    log.warn(
      { paymentIntentId },
      "providerFunding configured but pricingConfig missing — skipping funding"
    );
  }
  if (deps.providerFunding && deps.pricingConfig) {
    try {
      const topUpUsd = calculateOpenRouterTopUp(
        amountUsdCents,
        deps.pricingConfig.markupFactor,
        deps.pricingConfig.revenueShare,
        deps.pricingConfig.cryptoFee
      );
      const fundingOutcome = await deps.providerFunding.fundAfterCreditPurchase(
        {
          paymentIntentId,
          amountUsdCents,
          topUpUsd,
        }
      );

      // Step 6: TB co-write — record provider top-up (OperatorFloat → ProviderFloat)
      if (deps.financialLedger && fundingOutcome) {
        try {
          // topUpUsd is a float from pricing — convert to cents then to micro-USDC
          const topUpMicroUsdc =
            BigInt(Math.round(fundingOutcome.topUpUsd * 100)) *
            (USDC_SCALE / 100n);
          await deps.financialLedger.transfer({
            id: deterministicTransferId(
              paymentIntentId,
              TRANSFER_CODE.PROVIDER_TOPUP
            ),
            debitAccountId: ACCOUNT.ASSETS_OPERATOR_FLOAT,
            creditAccountId: ACCOUNT.ASSETS_PROVIDER_FLOAT,
            amount: topUpMicroUsdc,
            ledger: LEDGER.USDC,
            code: TRANSFER_CODE.PROVIDER_TOPUP,
          });
        } catch (err) {
          log.error(
            { err, paymentIntentId },
            "TB co-write failed for provider top-up — continuing"
          );
        }
      }
    } catch (err) {
      log.error(
        { err, paymentIntentId },
        "provider funding failed — credits confirmed, funding skipped"
      );
    }
  }

  log.info(
    {
      event: "payments.funding_complete",
      paymentIntentId,
      amountUsdCents,
      settlementOk: !!settlement,
      settlementError: !!settlementError,
      fundingConfigured: !!deps.providerFunding,
    },
    "post-credit funding chain complete"
  );

  return {
    ...(settlement ? { settlement } : {}),
    ...(settlementError ? { settlementError } : {}),
  };
}
