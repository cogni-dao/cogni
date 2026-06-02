// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/treasury-settlement`
 * Purpose: Treasury settlement port — semantic interface for forwarding confirmed credit revenue to DAO treasury.
 * Scope: Defines the settlement interface and outcome type. Does not expose token addresses, chain details, or distribution mechanics.
 * Invariants: SEMANTIC_PORT — method names describe business intent, not infrastructure mechanism.
 * Side-effects: none (interface definition only)
 * Links: docs/spec/operator-wallet.md, task.0085
 * @public
 */

/**
 * Outcome of a treasury settlement operation.
 */
export interface TreasurySettlementOutcome {
  /** On-chain transaction hash */
  txHash: string;
}

/**
 * Treasury settlement port — settles confirmed credit revenue to DAO treasury.
 * Today: distributes Split contract USDC to operator wallet + DAO treasury.
 * Tomorrow: may batch, queue, use different rails.
 */
export interface TreasurySettlementPort {
  /**
   * Settle treasury revenue from a confirmed credit purchase.
   *
   * @param context - Settlement context for traceability
   * @returns settlement outcome if on-chain tx occurred, undefined if no-op
   */
  settleConfirmedCreditPurchase(context: {
    paymentIntentId: string;
  }): Promise<TreasurySettlementOutcome | undefined>;
}
