// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/treasury/split-treasury-settlement`
 * Purpose: TreasurySettlementPort adapter that delegates to OperatorWalletPort.distributeSplit().
 * Scope: Bridges semantic treasury settlement to 0xSplits distribution mechanics. Does not expose token addresses or chain details to consumers.
 * Invariants: Token address injected at construction (not per-call). Delegates to OperatorWalletPort only.
 * Side-effects: IO (via OperatorWalletPort — on-chain tx submission)
 * Links: docs/spec/operator-wallet.md, task.0085
 * @public
 */

import type {
  OperatorWalletPort,
  TreasurySettlementOutcome,
  TreasurySettlementPort,
} from "@/ports";

/**
 * Treasury settlement via 0xSplits distribution.
 * Wraps OperatorWalletPort.distributeSplit() behind the semantic TreasurySettlementPort interface.
 */
export class SplitTreasurySettlementAdapter implements TreasurySettlementPort {
  constructor(
    private readonly wallet: OperatorWalletPort,
    private readonly token: string
  ) {}

  async settleConfirmedCreditPurchase(): Promise<
    TreasurySettlementOutcome | undefined
  > {
    const txHash = await this.wallet.distributeSplit(this.token);
    return { txHash };
  }
}
