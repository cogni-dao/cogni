// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet/tests/sign-x402`
 * Purpose: Unit tests for PrivyOperatorWalletAdapter.signX402Payment — the named x402 settlement signer.
 * Scope: Verifies the adapter constructs eth_signTypedData_v4 input from the EIP-3009 builder, returns the Privy signature, and enforces the authorizer (from === operator) gate. Mocks Privy SDK — no real API calls.
 * Invariants: NO_GENERIC_SIGNING (named method), X402_AUTHORIZER_MISMATCH gate, USDC-on-Base domain passed to Privy.
 * Side-effects: none
 * Links: packages/operator-wallet/src/adapters/privy/privy-operator-wallet.adapter.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

import type { X402PaymentParams } from "../src/port/operator-wallet.port.js";

const OPERATOR_ADDRESS = "0xdCCa8D85603C2CC47dc6974a790dF846f8695056";
const FAKE_WALLET_ID = "wallet-123";
const FAKE_SIGNATURE = `0x${"ab".repeat(65)}`;

const mockSignTypedData = vi
  .fn()
  .mockResolvedValue({ encoding: "hex", signature: FAKE_SIGNATURE });

class MockPrivyClient {
  wallets() {
    return {
      list: async function* () {
        yield { id: FAKE_WALLET_ID, address: OPERATOR_ADDRESS };
      },
      ethereum: () => ({
        signTypedData: mockSignTypedData,
      }),
    };
  }
}

vi.mock("@privy-io/node", () => ({
  PrivyClient: MockPrivyClient,
}));

// createPublicClient is only used by distributeSplit; stub it so the adapter
// constructs without a real RPC.
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      waitForTransactionReceipt: vi.fn(),
    }),
  };
});

const { PrivyOperatorWalletAdapter } = await import(
  "../src/adapters/privy/privy-operator-wallet.adapter.js"
);

function makeAdapter() {
  return new PrivyOperatorWalletAdapter({
    appId: "test-app",
    appSecret: "test-secret",
    signingKey: "test-key",
    expectedAddress: OPERATOR_ADDRESS,
    splitAddress: "0xd92EEc51C471CcF76996f0163Fd3cB6A61798f9C",
    treasuryAddress: "0xF61c3fafD4D34b4568e7a500d92b28Ac175e83C6",
    markupPpm: 2_000_000n,
    revenueSharePpm: 750_000n,
    maxTopUpUsd: 500,
    rpcUrl: "https://localhost:0/unused-in-unit-tests",
  });
}

const VALID_PARAMS: X402PaymentParams = {
  from: OPERATOR_ADDRESS,
  to: "0x4C4e559B2117AbA5f8BaE8a37d4B26BBAdc4C294",
  value: 1_039_500n,
  validAfter: 0n,
  validBefore: 1_800_000_000n,
  nonce: `0x${"11".repeat(32)}` as Hex,
};

describe("PrivyOperatorWalletAdapter.signX402Payment", () => {
  beforeEach(() => {
    mockSignTypedData.mockClear();
  });

  it("returns the Privy signature", async () => {
    const adapter = makeAdapter();
    const sig = await adapter.signX402Payment(VALID_PARAMS);
    expect(sig).toBe(FAKE_SIGNATURE);
    expect(mockSignTypedData).toHaveBeenCalledTimes(1);
  });

  it("submits eth_signTypedData_v4 input with the USDC-on-Base domain + struct", async () => {
    const adapter = makeAdapter();
    await adapter.signX402Payment(VALID_PARAMS);

    const [walletId, input] = mockSignTypedData.mock.calls[0];
    expect(walletId).toBe(FAKE_WALLET_ID);

    const td = input.params.typed_data;
    expect(td.primary_type).toBe("TransferWithAuthorization");
    expect(td.domain).toEqual({
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    });
    expect(td.types.TransferWithAuthorization).toEqual([
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ]);
    // Numeric fields are serialized to strings for the JSON-RPC typed-data shape.
    expect(td.message).toEqual({
      from: OPERATOR_ADDRESS,
      to: "0x4C4e559B2117AbA5f8BaE8a37d4B26BBAdc4C294",
      value: "1039500",
      validAfter: "0",
      validBefore: "1800000000",
      nonce: `0x${"11".repeat(32)}`,
    });
  });

  it("passes the Privy authorization context", async () => {
    const adapter = makeAdapter();
    await adapter.signX402Payment(VALID_PARAMS);
    const [, input] = mockSignTypedData.mock.calls[0];
    expect(input.authorization_context).toEqual({
      authorization_private_keys: ["test-key"],
    });
  });

  it("rejects when `from` is not the operator wallet (X402_AUTHORIZER_MISMATCH)", async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.signX402Payment({
        ...VALID_PARAMS,
        from: "0x0000000000000000000000000000000000000bad",
      })
    ).rejects.toThrow("X402_AUTHORIZER_MISMATCH");
    expect(mockSignTypedData).not.toHaveBeenCalled();
  });
});
