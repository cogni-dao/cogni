// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/operator-wallet.contract`
 * Purpose: Port contract tests for OperatorWalletPort — validates that adapters fulfill the port contract.
 * Scope: Tests FakeOperatorWalletAdapter against OperatorWalletPort interface. Does not test Privy API calls.
 * Invariants: NO_GENERIC_SIGNING — port exposes named methods only. All methods return expected types.
 * Side-effects: none
 * Links: src/ports/operator-wallet.port.ts
 * @internal
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { Hex } from "viem";
import {
  FakeOperatorWalletAdapter,
  getTestOperatorWallet,
  resetTestOperatorWallet,
} from "@/adapters/test";
import type { OperatorWalletPort, X402PaymentParams } from "@/ports";

const FAKE_X402_PARAMS: X402PaymentParams = {
  from: "0x1111111111111111111111111111111111111111",
  to: "0x4444444444444444444444444444444444444444",
  value: 1_000_000n,
  validAfter: 0n,
  validBefore: 1_800_000_000n,
  nonce: `0x${"11".repeat(32)}` as Hex,
};

describe("OperatorWalletPort contract", () => {
  let adapter: FakeOperatorWalletAdapter;

  beforeEach(() => {
    adapter = new FakeOperatorWalletAdapter();
  });

  it("getAddress returns a checksummed EVM address", async () => {
    const address = await adapter.getAddress();
    expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("getSplitAddress returns a checksummed EVM address", () => {
    const address = adapter.getSplitAddress();
    expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it("distributeSplit returns a transaction hash", async () => {
    const txHash = await adapter.distributeSplit(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    );
    expect(txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(adapter.lastDistributeSplitToken).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    );
  });

  it("signX402Payment returns an EIP-712 signature", async () => {
    const signature = await adapter.signX402Payment(FAKE_X402_PARAMS);
    expect(signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
    expect(adapter.lastX402Params).toEqual(FAKE_X402_PARAMS);
  });

  it("satisfies OperatorWalletPort interface", () => {
    // TypeScript compile-time check — if this doesn't compile, the port contract is broken
    const port: OperatorWalletPort = adapter;
    expect(port.getAddress).toBeDefined();
    expect(port.getSplitAddress).toBeDefined();
    expect(port.distributeSplit).toBeDefined();
    expect(port.signX402Payment).toBeDefined();
  });
});

describe("test singleton accessor", () => {
  beforeEach(() => {
    resetTestOperatorWallet();
  });

  it("returns the same instance on repeated calls", () => {
    const a = getTestOperatorWallet();
    const b = getTestOperatorWallet();
    expect(a).toBe(b);
  });

  it("reset clears state", async () => {
    const wallet = getTestOperatorWallet();
    await wallet.distributeSplit("0xtoken");
    expect(wallet.lastDistributeSplitToken).toBe("0xtoken");

    resetTestOperatorWallet();
    expect(wallet.lastDistributeSplitToken).toBeUndefined();
  });
});
