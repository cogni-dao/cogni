// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/provider-funding`
 * Purpose: Provider funding port — interface for topping up AI provider credits after a credit purchase.
 * Scope: Defines the funding interface and context type. Provider-agnostic (OpenRouter today, others tomorrow).
 * Invariants: PORT_BOUNDARY_CLEAN — separate from TreasurySettlementPort. SETTLEMENT_NON_BLOCKING — caller handles errors.
 * Side-effects: none (interface definition only)
 * Links: docs/spec/web3-openrouter-payments.md, task.0086
 * @public
 */

/**
 * Outcome of a provider funding operation.
 */
export interface ProviderFundingOutcome {
  /** On-chain transaction hash for the funding tx */
  txHash: string;
  /** Gross top-up amount in USD */
  topUpUsd: number;
}

/**
 * Context for provider funding after a credit purchase.
 */
export interface ProviderFundingContext {
  /** Payment intent ID from the credit purchase (idempotency key) */
  paymentIntentId: string;
  /** User payment amount in USD cents */
  amountUsdCents: number;
  /** Pre-calculated top-up amount in USD (from calculateOpenRouterTopUp) */
  topUpUsd: number;
}

/**
 * Provider funding port — tops up AI provider credits after a credit purchase.
 * Today: OpenRouter via Coinbase Commerce protocol.
 * Tomorrow: other providers, different funding rails.
 */
export interface ProviderFundingPort {
  /**
   * Fund provider credits for a confirmed credit purchase.
   * Manages charge creation, on-chain funding, and durable state.
   * Idempotent: safe to call multiple times for the same paymentIntentId.
   *
   * @param context - Funding context with payment details
   * @returns funding outcome if on-chain tx occurred, undefined if already funded or skipped
   * @throws on unrecoverable errors (caller should catch and log)
   */
  fundAfterCreditPurchase(
    context: ProviderFundingContext
  ): Promise<ProviderFundingOutcome | undefined>;
}
