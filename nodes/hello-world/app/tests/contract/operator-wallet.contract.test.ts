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

import {
  FakeOperatorWalletAdapter,
  getTestOperatorWallet,
  resetTestOperatorWallet,
} from "@/adapters/test";
import type { OperatorWalletPort, TransferIntent } from "@/ports";

const FAKE_INTENT: TransferIntent = {
  metadata: {
    sender: "0x1111111111111111111111111111111111111111",
    contract_address: "0x03059433BCdB6144624cC2443159D9445C32b7a8",
    chain_id: 8453,
  },
  call_data: {
    recipient_amount: "1000000",
    deadline: "2026-12-31T23:59:59Z",
    recipient: "0x4444444444444444444444444444444444444444",
    recipient_currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    refund_destination: "0x1111111111111111111111111111111111111111",
    fee_amount: "50000",
    id: "0x00000000000000000000000000000001",
    operator: "0x5555555555555555555555555555555555555555",
    signature: "0xdeadbeef",
    prefix: "0x",
  },
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

  it("fundOpenRouterTopUp returns a transaction hash", async () => {
    const txHash = await adapter.fundOpenRouterTopUp(FAKE_INTENT);
    expect(txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(adapter.lastFundTopUpIntent).toEqual(FAKE_INTENT);
  });

  it("satisfies OperatorWalletPort interface", () => {
    // TypeScript compile-time check — if this doesn't compile, the port contract is broken
    const port: OperatorWalletPort = adapter;
    expect(port.getAddress).toBeDefined();
    expect(port.getSplitAddress).toBeDefined();
    expect(port.distributeSplit).toBeDefined();
    expect(port.fundOpenRouterTopUp).toBeDefined();
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
