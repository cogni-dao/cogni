// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet/port`
 * Purpose: Operator wallet port — narrow, typed interface for outbound on-chain payments.
 * Scope: Defines the operator wallet interface and TransferIntent type. Does not implement custody logic or hold key material.
 * Invariants:
 *   - NO_GENERIC_SIGNING — the port has no `signTransaction(calldata)` / `signMessage(bytes)` surface.
 *   - KEY_NEVER_IN_APP — no raw key material.
 * Side-effects: none (interface definition only)
 * Links: docs/spec/operator-wallet.md, work/items/task.0315.poly-copy-trade-prototype.md
 * @public
 */

/**
 * TransferIntent from OpenRouter's /api/v1/credits/coinbase endpoint.
 * Describes the on-chain action needed to fund OpenRouter credits via
 * the Coinbase Commerce Onchain Payment Protocol.
 *
 * The adapter encodes `transferTokenPreApproved` calldata internally —
 * callers pass the raw API response shape, not ABI-encoded data.
 * Validated by spike.0090 on Base mainnet (2026-03-09).
 *
 * See: scripts/experiments/full-chain.ts:58-69
 */
export interface TransferIntent {
  metadata: {
    /** Sender address — must match operator wallet address */
    sender: string;
    /** Target contract address (Coinbase Transfers) */
    contract_address: string;
    /** Chain ID for the transaction */
    chain_id: number;
  };
  call_data: {
    /** USDC atomic units (6 decimals), e.g. "1039500" = 1.0395 USDC */
    recipient_amount: string;
    /** ISO 8601 string or unix timestamp — charge expiry deadline */
    deadline: string;
    /** OpenRouter's receiving address */
    recipient: string;
    /** ERC-20 token address (Base USDC) */
    recipient_currency: string;
    /** Refund destination on revert */
    refund_destination: string;
    /** USDC atomic units — OpenRouter's fee (e.g. "10500" = 0.0105 USDC) */
    fee_amount: string;
    /** bytes16 charge identifier */
    id: string;
    /** Coinbase Commerce operator address */
    operator: string;
    /** OpenRouter's authorization signature */
    signature: string;
    /** Signature prefix */
    prefix: string;
  };
}

/**
 * Operator wallet port — a bounded payments actuator.
 * Each outbound transaction type gets a named method. No raw signing surface.
 *
 * Polymarket CLOB order signing is NOT on this port: it is handled directly
 * in the trader-role runtime via `@privy-io/node/viem#createViemAccount`,
 * which produces a viem `LocalAccount` that `@polymarket/clob-client` consumes
 * natively. Wrapping that in a bespoke port added no value — see task.0315 CP2.
 */
export interface OperatorWalletPort {
  /** Return the operator wallet's public address (checksummed) */
  getAddress(): Promise<string>;

  /** Return the Split contract address (from repo-spec) */
  getSplitAddress(): string;

  /**
   * Trigger USDC distribution on the Split contract.
   * Sends operator share to this wallet, DAO share to treasury.
   *
   * @param token - ERC-20 token address (USDC)
   * @returns txHash on successful broadcast
   */
  distributeSplit(token: string): Promise<string>;

  /**
   * Fund OpenRouter credits via Coinbase Commerce protocol.
   * Encodes the appropriate Transfers function internally — caller cannot control calldata.
   *
   * @param intent - TransferIntent from OpenRouter's /api/v1/credits/coinbase
   * @returns txHash on successful broadcast
   * @throws if contract not allowlisted, sender mismatch, or value exceeds cap
   *
   * @deprecated OpenRouter removed the Coinbase Commerce charge API (returns 410
   * Gone). Outbound vendor funding now flows through `withdrawToSteward` + a manual
   * human checkout — see docs/design/node-steward-wallet.md. Retained until the
   * dead funding chain is removed.
   */
  fundOpenRouterTopUp(intent: TransferIntent): Promise<string>;

  /**
   * Fund the human-custodied steward wallet with a single USDC transfer.
   *
   * The destination is PINNED to the repo-spec `payments_out.steward_wallet`
   * address (the caller controls only the amount, never the recipient). This is
   * the operator wallet's only generic-value outbound, and it stays within
   * NO_GENERIC_SIGNING because the method encodes a fixed ERC-20
   * `transfer(stewardAddress, amount)` to a config-pinned recipient — not
   * arbitrary calldata. A human then settles vendor invoices (OpenRouter, Cherry)
   * in USDC from that wallet via each vendor's hosted crypto checkout.
   *
   * @param amountUsdcAtomic - USDC atomic units (6 decimals) to transfer
   * @returns txHash on successful broadcast
   * @throws if the steward wallet is not configured or the amount exceeds the per-tx cap
   */
  withdrawToSteward(amountUsdcAtomic: bigint): Promise<string>;
}
