// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/application/confirmCreditsPurchase`
 * Purpose: Application orchestrator — composes credit confirmation with treasury settlement and the TigerBeetle Split-distribute co-write.
 * Scope: Orchestrates the post-credit chain: credit user → settle treasury (Split distribute) → record the Treasury→OperatorFloat USDC movement in TB.
 *   Steps 1-2 (credits) always succeed independently. Steps 3-4 (settlement, TB) are non-blocking — log critical on failure.
 *   `runPostCreditFunding` is extracted so both the widget path (confirmCreditsPurchase) and on-chain path (verifyAndSettle) can invoke post-credit steps.
 * Invariants:
 *   - Credit confirmation always succeeds independently of downstream steps
 *   - Settlement skipped on idempotent replay
 *   - SETTLEMENT_NON_BLOCKING: Steps 3-4 never fail the user response
 *   - CO_WRITE_NON_BLOCKING: TigerBeetle writes fire-and-forget
 * Notes: The dead OpenRouter/Coinbase provider-funding path (old steps 5-6: ProviderFundingPort + OperatorFloat→ProviderFloat co-write) was retired — OpenRouter 410'd programmatic crypto top-up. AI egress now pays per-request in USDC over x402 (operator wallet signs EIP-3009, facilitator broadcasts); that lands in a later PR. Inbound crediting + Split distribute are unchanged.
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
import { EVENT_NAMES } from "@cogni/node-shared";
import type { Logger } from "pino";
import { v5 as uuidv5 } from "uuid";
import {
  type CreditsConfirmInput,
  confirmCreditsPayment,
} from "@/features/payments/services/creditsConfirm";
import type {
  AccountService,
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
  log: Logger;
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
// Post-credit funding (steps 3-4) — extracted for reuse by on-chain path
// ---------------------------------------------------------------------------

export interface PostCreditFundingDeps {
  treasurySettlement: TreasurySettlementPort | undefined;
  financialLedger: FinancialLedgerPort | undefined;
  log: Logger;
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
 * Confirm a credit purchase and run the post-credit settlement chain.
 *
 * Steps 1-2 (credit user + mint system tenant bonus) delegate to confirmCreditsPayment.
 * Step 3 (treasury settlement) delegates to TreasurySettlementPort (Split distribute).
 * Step 4 (TB co-write) records Treasury → OperatorFloat in TigerBeetle.
 *
 * Steps 3-4 are non-blocking — log critical on failure, never fail user response.
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

  // Steps 3-4: post-credit chain (treasury settlement + TB co-write)
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
 * Run post-credit chain (steps 3-4).
 *
 * Step 3: Treasury settlement — call Split distribute via TreasurySettlementPort.
 * Step 4: TB co-write — record Split distribute (Treasury → OperatorFloat).
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

  // Terminal event — carries the on-chain Split-distribute txn so the
  // payments→DAO path is traceable by paymentIntentId in one query.
  log.info(
    {
      event: EVENT_NAMES.PAYMENTS_FUNDING_COMPLETE,
      paymentIntentId,
      amountUsdCents,
      settlementOk: !!settlement,
      settlementError: !!settlementError,
      // Split distribute (Treasury → operator + DAO) tx
      distributeTxHash: settlement?.txHash,
    },
    "post-credit settlement chain complete"
  );

  return {
    ...(settlement ? { settlement } : {}),
    ...(settlementError ? { settlementError } : {}),
  };
}
