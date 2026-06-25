// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/payments/funding-ready-rail-guard`
 * Purpose: Fail-closed guard that refuses payment intents when the OUTBOUND funding
 *   loop is not wired (operator wallet / provider funding absent), even if the
 *   inbound Split economics are valid.
 * Scope: Composes an inner PaymentRailGuardPort (Split-hash check). Asserts funding
 *   readiness first, then delegates. No chain reads of its own.
 * Invariants: When `fundingReady` is false, every assertReady() throws
 *   PAYMENT_RAIL_UNCONFIGURED — the rail is all-or-nothing. We never accept USDC the
 *   node cannot distribute + top up (bug.5087: $2 stuck in Split, OpenRouter never
 *   topped up because Privy creds were absent → operatorWallet/providerFunding undefined).
 * Side-effects: none (delegates IO to the inner guard)
 * Links: docs/spec/payments-design.md, docs/spec/operator-wallet.md
 * @public
 */

import {
  type PaymentRailGuardConfig,
  type PaymentRailGuardPort,
  PaymentRailMisconfiguredPortError,
} from "@/ports";

/**
 * Wraps an inner payment-rail guard with an outbound-funding readiness gate.
 *
 * The inbound guard (Split-hash) proves the node can RECEIVE USDC at the correct
 * economics. It says nothing about whether the node can LOOP that money out
 * (Split distribute + OpenRouter top-up). That loop requires `operatorWallet` AND
 * `providerFunding` to be wired in the container. When they are not, crediting the
 * user is a silent decoupling: money lands inbound but stays stuck in the Split.
 *
 * This adapter makes the rail fail closed at intent creation: if funding is not
 * ready, no transfer params are ever issued and the route returns 503.
 */
export class FundingReadyRailGuardAdapter implements PaymentRailGuardPort {
  constructor(
    private readonly inner: PaymentRailGuardPort,
    private readonly fundingReady: boolean
  ) {}

  async assertReady(config: PaymentRailGuardConfig): Promise<void> {
    if (!this.fundingReady) {
      throw new PaymentRailMisconfiguredPortError(
        "PAYMENT_RAIL_UNCONFIGURED",
        "outbound funding not configured — operatorWallet/providerFunding absent"
      );
    }
    await this.inner.assertReady(config);
  }
}
