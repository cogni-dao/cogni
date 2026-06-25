// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/treasury/hyperbolic-x402-topup.port`
 * Purpose: Drawdown-triggered provider-funding port for BULK topping up a
 *   prepaid AI inference balance (Hyperbolic, Tier-1).
 * Scope: Interface + context/outcome types only. Provider-agnostic shape.
 *
 * ⚠️ SCAFFOLD — co-located with hyperbolic-x402-topup.adapter.ts. Deliberately a
 *    NEW file (not the `src/ports/provider-funding.port.ts` that PR #1844 deletes)
 *    so this scaffold does NOT create a delete-vs-modify merge conflict with
 *    #1844. Promote into `src/ports/` only after #1844 lands and this is wired.
 *
 * DESIGN NOTE — trigger model differs from the retired (#1844) funding port:
 *   OLD: INBOUND-triggered — fund right after each credit purchase (paymentIntentId).
 *   NEW: DRAWDOWN-triggered — the shared LiteLLM cost callback accumulates spend;
 *        a watcher refills ONCE when the prepaid balance crosses a floor. This is
 *        explicitly NOT per-request x402 (the anti-pattern).
 *
 * Invariants:
 *   - PORT_BOUNDARY_CLEAN — separate from TreasurySettlementPort and the
 *     operator-wallet port (which only SIGNS; this orchestrates the top-up).
 *   - SETTLEMENT_NON_BLOCKING — a failed top-up never blocks inference.
 *   - IDEMPOTENT_BY_THRESHOLD — re-invoking above the floor is a no-op.
 * Side-effects: none (interface definition only)
 * Links: ./hyperbolic-x402-topup.adapter.ts, PR #1844 (signX402Payment)
 * @public
 */

/** Outcome of a bulk top-up. Present only when value actually moved. */
export interface ProviderFundingOutcome {
  /** On-chain tx hash for the funding transfer, or facilitator settlement ref. */
  txHash: string;
  /** Gross top-up amount in USD that was sent to the provider. */
  topUpUsd: number;
}

/** Context for a drawdown-triggered bulk top-up. */
export interface ProviderFundingContext {
  /** Provider's current remaining prepaid balance in USD (observed by the watcher). */
  currentBalanceUsd: number;
  /** Refill when currentBalanceUsd drops at/below this floor. */
  thresholdUsd: number;
  /** Target balance to refill UP TO (top-up amount = target - current). */
  targetBalanceUsd: number;
  /** Idempotency / correlation key (e.g. time-bucket) to dedupe concurrent watchers. */
  topUpKey: string;
}

/**
 * Provider funding port — bulk-refills a prepaid AI inference balance on drawdown.
 * Today (Tier-1): Hyperbolic, funded by an operator-wallet USDC transfer on Base.
 */
export interface ProviderFundingPort {
  /**
   * Bulk top-up the provider's prepaid balance to the target floor.
   * Idempotent by threshold: if currentBalanceUsd > thresholdUsd, no-op (undefined).
   *
   * @param context - drawdown funding context
   * @returns outcome if a top-up occurred, undefined if above floor / skipped
   * @throws on unrecoverable errors (caller catches + logs; non-blocking)
   */
  topUpToFloor(
    context: ProviderFundingContext
  ): Promise<ProviderFundingOutcome | undefined>;
}
