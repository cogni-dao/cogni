// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet/domain/x402-eip3009`
 * Purpose: Deterministic EIP-712 typed-data construction for USDC EIP-3009 `TransferWithAuthorization` on Base.
 * Scope: Pure builders for the EIP-712 domain + types + message used by x402 settlement signing. No I/O, no signing.
 * Invariants:
 *   - USDC_ON_BASE: domain pins name "USD Coin", version "2", chainId 8453, verifyingContract = canonical Base USDC.
 *   - EIP3009_STRUCT: `TransferWithAuthorization{from,to,value,validAfter,validBefore,nonce}` field order matches the deployed USDC contract.
 *   - DETERMINISTIC: same inputs → byte-identical typed data (and hash). No clock/random reads.
 * Side-effects: none
 * Links: https://eips.ethereum.org/EIPS/eip-3009, https://x402.org, packages/operator-wallet/src/port/operator-wallet.port.ts
 * @public
 */

import type { Address, Hex, TypedData, TypedDataDomain } from "viem";
import { getAddress } from "viem";
import type { X402PaymentParams } from "../port/operator-wallet.port.js";

/** Base chain ID (EIP-3009 domain separator binds the signature to this chain). */
export const BASE_CHAIN_ID = 8453;

/**
 * USDC on Base (6 decimals). Canonical source:
 * nodes/operator/app/src/shared/web3/chain.ts:USDC_TOKEN_ADDRESS.
 */
export const USDC_ADDRESS = getAddress(
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
);

/**
 * EIP-712 domain name for Base USDC. Per the deployed FiatTokenV2_2 contract,
 * `name()` is "USD Coin" and `version()` is "2" — both are part of the domain
 * separator, so they must match the contract exactly or signatures will not
 * recover to the authorizer on-chain.
 */
export const USDC_EIP712_NAME = "USD Coin";
export const USDC_EIP712_VERSION = "2";

/** Canonical EIP-3009 struct name for an authorized transfer. */
export const TRANSFER_WITH_AUTHORIZATION = "TransferWithAuthorization";

/**
 * EIP-712 type set for `TransferWithAuthorization`. Field order is load-bearing:
 * it must match the USDC contract's struct so the typed-data hash matches.
 */
export const X402_EIP712_TYPES = {
  [TRANSFER_WITH_AUTHORIZATION]: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const satisfies TypedData;

/** Build the EIP-712 domain for USDC on Base. */
export function buildX402Domain(): TypedDataDomain {
  return {
    name: USDC_EIP712_NAME,
    version: USDC_EIP712_VERSION,
    chainId: BASE_CHAIN_ID,
    verifyingContract: USDC_ADDRESS,
  };
}

/**
 * Fully-typed EIP-712 payload for an EIP-3009 `TransferWithAuthorization`.
 * Shape is the canonical viem `signTypedData` argument set.
 */
export interface X402TypedData {
  domain: TypedDataDomain;
  types: typeof X402_EIP712_TYPES;
  primaryType: typeof TRANSFER_WITH_AUTHORIZATION;
  message: {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  };
}

/**
 * Construct the deterministic EIP-712 typed data for an x402 settlement.
 * Addresses are checksum-normalized; numeric params pass through as bigint.
 * Pure — no signing, no I/O.
 */
export function buildX402TypedData(params: X402PaymentParams): X402TypedData {
  return {
    domain: buildX402Domain(),
    types: X402_EIP712_TYPES,
    primaryType: TRANSFER_WITH_AUTHORIZATION,
    message: {
      from: getAddress(params.from),
      to: getAddress(params.to),
      value: params.value,
      validAfter: params.validAfter,
      validBefore: params.validBefore,
      nonce: params.nonce,
    },
  };
}
