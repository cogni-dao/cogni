// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/treasury/hyperbolic-x402-topup`
 * Purpose: SCAFFOLD for the Tier-1 Hyperbolic prepaid-balance bulk top-up adapter.
 * Scope: Re-introduces a drawdown-triggered provider-funding seam (the seam PR
 *   #1844 retired for OpenRouter) and the interface for the Hyperbolic top-up.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️  TODO — STUB ONLY. DO NOT WIRE. DO NOT IMPORT FROM bootstrap/container.ts.
 * ════════════════════════════════════════════════════════════════════════════
 * This file is a typed skeleton so the design is reviewable in code form. It is
 * intentionally NOT registered in the DI container and has NO live caller. Every
 * method that would move money THROWS `NotImplementedError`. It compiles but does
 * nothing.
 *
 * BLOCKED ON (both must resolve before this is implemented):
 *   1. PR #1844 merge — provides `OperatorWalletPort.signX402Payment(params)` and
 *      the `X402PaymentParams` type in `@cogni/operator-wallet`. This stub does
 *      NOT import from #1844 yet (it isn't on main); the import sites are marked
 *      `TODO(#1844)` so wiring is a mechanical follow-up once it lands.
 *   2. CONFIRMED Hyperbolic top-up target — see "PART A FINDINGS" below. We know
 *      the MECHANISM (send USDC on Base to Hyperbolic's per-account deposit
 *      address; credits auto-convert) but NOT the programmatic target details:
 *      there is NO Hyperbolic top-up API endpoint, and the deposit address is
 *      shown only in the dashboard after "Add Wallet Address". So the exact
 *      `to` address + whether an x402 facilitator broadcasts the signed EIP-3009
 *      authorization (vs. a plain ERC-20 transfer) is UNVERIFIED. We do NOT
 *      fabricate that call here.
 *
 * ── PART A FINDINGS (cited; researched 2026-06-25) ──────────────────────────
 * Hyperbolic prepaid-balance funding options:
 *   • Manual crypto deposit (Tier-1 target): "select Add Wallet Address and
 *     connect your wallet, then transfer stablecoins (USDC, USDT, or DAI) on
 *     BASE to the provided Hyperbolic wallet address" → credits appear instantly.
 *     => There is a per-account Hyperbolic deposit address on Base. NO API to
 *        fetch it programmatically was found (dashboard-only).
 *     (hyperbolic.ai/blog/pay-for-gpu-and-ai-inference-models-with-crypto)
 *   • Auto Top-Up: dashboard-only + SAVED CARD only (not crypto, no API).
 *     (hyperbolic.ai/blog/auto-top-ups)
 *   • hyperbolic-x402 (github.com/HyperbolicLabs/hyperbolic-x402): PER-REQUEST
 *     402 payment for chat completions — the EXPLICIT ANTI-PATTERN we avoid; it
 *     does NOT top up a balance.
 *   => CONCLUSION: the Tier-1 bulk top-up is an operator-wallet USDC transfer on
 *      Base to Hyperbolic's deposit address. NO programmatic top-up API exists.
 *
 * ── IMPLEMENTATION SHAPE (once unblocked) ───────────────────────────────────
 * topUpToFloor(ctx):
 *   1. Idempotency: if ctx.currentBalanceUsd > ctx.thresholdUsd → return undefined.
 *   2. amount = ctx.targetBalanceUsd - ctx.currentBalanceUsd (USDC, 6 decimals).
 *   3. Build X402PaymentParams { from: operator addr, to: HYPERBOLIC_DEPOSIT_ADDR,
 *      value: usdToAtomic(amount), validAfter: 0n, validBefore: now+window,
 *      nonce: random bytes32 }.
 *   4. sig = await operatorWallet.signX402Payment(params)   // TODO(#1844)
 *   5. Settle: EITHER (a) submit {params, sig} to a Hyperbolic/x402 facilitator
 *      that broadcasts transferWithAuthorization, OR (b) if Hyperbolic only
 *      accepts a plain transfer, broadcast an ERC-20 transfer instead (then the
 *      EIP-3009 signing path is not the right tool and we'd use a different
 *      operator-wallet method). WHICH ONE depends on Hyperbolic confirmation —
 *      hence UNVERIFIED. DO NOT pick one here.
 *   6. Record outcome { txHash, topUpUsd: amount } durably (idempotency ledger).
 *
 * TRIGGER (not in this file): the shared LiteLLM cost callback
 * (infra/images/litellm/cogni_callbacks.py) accumulates per-node spend; a
 * drawdown watcher reads the running balance and calls topUpToFloor ONCE when it
 * crosses thresholdUsd. NOT per-request (that is the x402 anti-pattern).
 *
 * Invariants: SETTLEMENT_NON_BLOCKING, IDEMPOTENT_BY_THRESHOLD, KEY_NEVER_IN_APP
 *   (signing stays behind the operator-wallet port; this adapter never holds key
 *   material). PORT_BOUNDARY_CLEAN (separate from TreasurySettlementPort).
 * Side-effects: NONE today (stub). When implemented: on-chain USDC transfer.
 * Links: PR #1844 (signX402Payment), infra/secrets-catalog.yaml (HYPERBOLIC_API_KEY),
 *   infra/images/litellm/cogni_callbacks.py (drawdown trigger)
 * @internal
 */

import type {
  ProviderFundingContext,
  ProviderFundingOutcome,
  ProviderFundingPort,
} from "./hyperbolic-x402-topup.port.js";

// TODO(#1844): once #1844 is on main, import the real wallet port + x402 types:
//   import type { OperatorWalletPort, X402PaymentParams } from "@cogni/operator-wallet";
// The adapter takes the wallet port via constructor injection (KEY_NEVER_IN_APP).

class NotImplementedError extends Error {
  constructor(detail: string) {
    super(`HyperbolicX402TopUpAdapter: ${detail}`);
    this.name = "NotImplementedError";
  }
}

/**
 * Config the adapter needs once implemented. UNVERIFIED fields are explicit.
 */
export interface HyperbolicTopUpConfig {
  /**
   * ⚠️ UNVERIFIED (Part A): Hyperbolic's per-account USDC-on-Base deposit address.
   * Only visible in the dashboard after "Add Wallet Address" — no API to fetch
   * it. Must be captured as config/secret once a Hyperbolic account exists.
   */
  hyperbolicDepositAddress?: string;
  /**
   * ⚠️ UNVERIFIED (Part A): whether settlement goes through an x402 facilitator
   * (broadcasts the signed EIP-3009 authorization) or a plain ERC-20 transfer.
   * Decides whether signX402Payment is even the right primitive.
   */
  settlementMode?: "x402-facilitator" | "plain-erc20-transfer";
}

/**
 * Tier-1 Hyperbolic prepaid-balance bulk top-up adapter.
 *
 * STUB: throws until #1844 merges AND the Hyperbolic deposit target is confirmed.
 * Constructor will take the operator-wallet port + HyperbolicTopUpConfig.
 */
export class HyperbolicX402TopUpAdapter implements ProviderFundingPort {
  // TODO(#1844): constructor(private readonly wallet: OperatorWalletPort,
  //                          private readonly config: HyperbolicTopUpConfig) {}

  async topUpToFloor(
    context: ProviderFundingContext
  ): Promise<ProviderFundingOutcome | undefined> {
    void context;
    // Idempotency guard (the one piece safe to express now):
    if (context.currentBalanceUsd > context.thresholdUsd) {
      return undefined; // above floor — no top-up needed.
    }
    throw new NotImplementedError(
      "blocked on PR #1844 (signX402Payment) + confirmed Hyperbolic deposit " +
        "target (Part A: deposit address is dashboard-only, no top-up API)."
    );
  }
}
