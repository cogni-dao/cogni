// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/operator-wallet.contract`
 * Purpose: Port contract tests for OperatorWalletPort — validates that adapters fulfill the port contract.
 * Scope: Fake port and real Privy withdrawal method with injected fake RPC/SDK boundaries. No network calls.
 * Invariants: NO_GENERIC_SIGNING — port exposes named methods only. All methods return expected types.
 * Side-effects: none
 * Links: src/ports/operator-wallet.port.ts
 * @internal
 */

import { PrivyOperatorWalletAdapter } from "@cogni/operator-wallet/adapters/privy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeOperatorWalletAdapter,
  getTestOperatorWallet,
  resetTestOperatorWallet,
} from "@/adapters/test";
import type { OperatorWalletPort } from "@/ports";

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

  it("withdrawToSteward returns a transaction hash and explicit receipt status", async () => {
    const { txHash, receiptStatus } =
      await adapter.withdrawToSteward(1_000_000n);
    expect(txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(receiptStatus).toBe("success");
    expect(adapter.lastWithdrawToStewardAmount).toBe(1_000_000n);
  });

  it("satisfies OperatorWalletPort interface", () => {
    // TypeScript compile-time check — if this doesn't compile, the port contract is broken
    const port: OperatorWalletPort = adapter;
    expect(port.getAddress).toBeDefined();
    expect(port.getSplitAddress).toBeDefined();
    expect(port.distributeSplit).toBeDefined();
    expect(port.withdrawToSteward).toBeDefined();
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

describe("Privy steward receipt outcomes", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("No live IO allowed");
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    "success",
    "reverted",
    "pending",
  ] as const)("keeps %s distinct without losing the broadcast hash", async (receiptStatus) => {
    const txHash = `0x${"a".repeat(64)}`;
    const sendTransaction = vi.fn(async () => ({ hash: txHash }));
    const waitForTransactionReceipt = vi.fn(async () => {
      if (receiptStatus === "pending") throw new Error("RPC timeout");
      return { status: receiptStatus };
    });
    // Exercise the real method while replacing only external service boundaries.
    const adapter = Object.assign(
      Object.create(PrivyOperatorWalletAdapter.prototype),
      {
        walletId: "fake-wallet",
        stewardAddress: "0x1111111111111111111111111111111111111111",
        maxTopUpUsd: 100,
        authContext: {},
        client: { wallets: () => ({ ethereum: () => ({ sendTransaction }) }) },
        rpcClient: { waitForTransactionReceipt },
      }
    ) as PrivyOperatorWalletAdapter;
    expect(await adapter.withdrawToSteward(1_000_000n)).toEqual({
      txHash,
      receiptStatus,
    });
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
