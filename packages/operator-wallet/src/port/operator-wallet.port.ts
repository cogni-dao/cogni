// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet/port`
 * Purpose: Operator wallet port — narrow, typed interface for outbound on-chain payments.
 * Scope: Defines the operator wallet interface and x402 settlement signing types. Does not implement custody logic or hold key material.
 * Invariants:
 *   - NO_GENERIC_SIGNING — the port has no `signTransaction(calldata)` / `signMessage(bytes)` surface.
 *     Each signing method is named for its use-case (e.g. `signX402Payment`), never a generic `signTypedData`.
 *   - KEY_NEVER_IN_APP — no raw key material.
 * Side-effects: none (interface definition only)
 * Links: docs/spec/operator-wallet.md, work/items/task.0315.poly-copy-trade-prototype.md
 * @public
 */

import type { Hex } from "viem";

/**
 * Parameters for an EIP-3009 `TransferWithAuthorization` (USDC on Base).
 *
 * This is the off-chain authorization a facilitator (x402 backend) submits
 * on-chain via `transferWithAuthorization`. Cogni pays inference per-request in
 * USDC over x402: the operator wallet signs this authorization; the facilitator
 * broadcasts it. Use-case-named (x402 settlement), NOT a generic typed-data
 * surface — preserves NO_GENERIC_SIGNING.
 *
 * All numeric fields are domain primitives (`bigint`) so the port never leaks the
 * on-chain encoding; the adapter serializes to EIP-712 string form. `nonce` is a
 * random 32-byte value (bytes32) that makes each authorization single-use.
 *
 * See: https://eips.ethereum.org/EIPS/eip-3009 · https://x402.org
 */
export interface X402PaymentParams {
  /** Authorizer / payer address (must be the operator wallet address). */
  from: string;
  /** Payee address (the x402 facilitator / resource server's receiving address). */
  to: string;
  /** USDC atomic units (6 decimals), e.g. 1_039_500n = 1.0395 USDC. */
  value: bigint;
  /** Unix seconds — authorization is invalid before this time. */
  validAfter: bigint;
  /** Unix seconds — authorization is invalid at/after this time. */
  validBefore: bigint;
  /** Random bytes32 nonce making this authorization single-use (0x-prefixed, 32 bytes). */
  nonce: Hex;
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
   * Sign an EIP-3009 `TransferWithAuthorization` for x402 AI-egress settlement.
   *
   * Produces the off-chain signature a facilitator submits on-chain via
   * `transferWithAuthorization` — this method NEVER broadcasts. The EIP-712
   * domain (USDC on Base, chainId 8453) and the `TransferWithAuthorization`
   * struct are constructed by the adapter; the caller supplies only the domain
   * params. Named for its use-case to preserve NO_GENERIC_SIGNING — this is not
   * a generic `signTypedData` surface.
   *
   * @param params - EIP-3009 authorization params (from/to/value/validAfter/validBefore/nonce)
   * @returns the EIP-712 signature (0x-prefixed, 65 bytes)
   */
  signX402Payment(params: X402PaymentParams): Promise<Hex>;
}
