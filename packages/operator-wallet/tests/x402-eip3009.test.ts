// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet/tests/x402-eip3009`
 * Purpose: Deterministic unit tests for the EIP-712 typed-data construction used by x402 settlement signing.
 * Scope: Asserts the EIP-3009 `TransferWithAuthorization` domain, struct field order, and typed-data hash for fixed inputs. Pure — no Privy, no chain.
 * Invariants: USDC-on-Base domain (name/version/chainId/verifyingContract) and struct order are pinned; same input → same hash.
 * Side-effects: none
 * Links: packages/operator-wallet/src/domain/x402-eip3009.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import { type Hex, hashTypedData } from "viem";

import {
  BASE_CHAIN_ID,
  buildX402Domain,
  buildX402TypedData,
  TRANSFER_WITH_AUTHORIZATION,
  USDC_ADDRESS,
  USDC_EIP712_NAME,
  USDC_EIP712_VERSION,
} from "../src/domain/x402-eip3009.js";
import type { X402PaymentParams } from "../src/port/operator-wallet.port.js";

// Fixed, fully-deterministic inputs (lowercased addresses to also prove checksum normalization).
const FIXED_PARAMS: X402PaymentParams = {
  from: "0xdcca8d85603c2cc47dc6974a790df846f8695056",
  to: "0x4c4e559b2117aba5f8bae8a37d4b26bbadc4c294",
  value: 1_039_500n, // 1.0395 USDC (6 decimals)
  validAfter: 0n,
  validBefore: 1_800_000_000n,
  nonce: `0x${"11".repeat(32)}` as Hex,
};

describe("x402 EIP-3009 typed-data construction", () => {
  it("pins the USDC-on-Base EIP-712 domain", () => {
    const domain = buildX402Domain();
    expect(domain).toEqual({
      name: USDC_EIP712_NAME,
      version: USDC_EIP712_VERSION,
      chainId: BASE_CHAIN_ID,
      verifyingContract: USDC_ADDRESS,
    });
    // Hard-pin the literals so an accidental edit is caught.
    expect(domain.name).toBe("USD Coin");
    expect(domain.version).toBe("2");
    expect(domain.chainId).toBe(8453);
    expect(domain.verifyingContract).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    );
  });

  it("pins the TransferWithAuthorization struct field order", () => {
    const typed = buildX402TypedData(FIXED_PARAMS);
    expect(typed.primaryType).toBe(TRANSFER_WITH_AUTHORIZATION);
    expect(typed.types[TRANSFER_WITH_AUTHORIZATION]).toEqual([
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ]);
  });

  it("checksum-normalizes from/to and passes numeric fields through", () => {
    const typed = buildX402TypedData(FIXED_PARAMS);
    expect(typed.message.from).toBe(
      "0xdCCa8D85603C2CC47dc6974a790dF846f8695056"
    );
    expect(typed.message.to).toBe("0x4C4e559B2117AbA5f8BaE8a37d4B26BBAdc4C294");
    expect(typed.message.value).toBe(1_039_500n);
    expect(typed.message.validAfter).toBe(0n);
    expect(typed.message.validBefore).toBe(1_800_000_000n);
    expect(typed.message.nonce).toBe(`0x${"11".repeat(32)}`);
  });

  it("produces a stable EIP-712 hash for fixed inputs (regression pin)", () => {
    const typed = buildX402TypedData(FIXED_PARAMS);
    const hash = hashTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    // Deterministic digest of the pinned domain + struct + fixed message.
    // If this changes, the signed authorization changed shape — review carefully.
    expect(hash).toBe(
      "0xf30ee7af74b0d783194cc0f662ee1bd50c026e87d8435a8442b3c3e10484c640"
    );
  });
});
