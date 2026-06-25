// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/test/wallet/fake-operator-wallet`
 * Purpose: Fake operator wallet adapter for deterministic testing.
 * Scope: In-memory test double returning configurable responses. Does not perform real Privy or chain calls.
 * Invariants: Deterministic behavior based on configuration; tracks call params for assertions.
 * Side-effects: none (in-memory only)
 * Links: Implements OperatorWalletPort
 * @public
 */

import type { Hex } from "viem";
import type { OperatorWalletPort, X402PaymentParams } from "@/ports";

const FAKE_OPERATOR_ADDRESS = "0x1111111111111111111111111111111111111111";
const FAKE_SPLIT_ADDRESS = "0x2222222222222222222222222222222222222222";
const FAKE_TX_HASH =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FAKE_X402_SIGNATURE = `0x${"cd".repeat(65)}` as Hex;

export class FakeOperatorWalletAdapter implements OperatorWalletPort {
  private address = FAKE_OPERATOR_ADDRESS;
  private splitAddress = FAKE_SPLIT_ADDRESS;
  private distributeSplitResult = FAKE_TX_HASH;
  private signX402Result: Hex = FAKE_X402_SIGNATURE;

  /** Last params passed to distributeSplit */
  public lastDistributeSplitToken: string | undefined;
  /** Last params passed to signX402Payment */
  public lastX402Params: X402PaymentParams | undefined;

  async getAddress(): Promise<string> {
    return this.address;
  }

  getSplitAddress(): string {
    return this.splitAddress;
  }

  async distributeSplit(token: string): Promise<string> {
    this.lastDistributeSplitToken = token;
    return this.distributeSplitResult;
  }

  async signX402Payment(params: X402PaymentParams): Promise<Hex> {
    this.lastX402Params = params;
    return this.signX402Result;
  }

  // ── Test helpers ──

  setAddress(address: string): void {
    this.address = address;
  }

  setSplitAddress(splitAddress: string): void {
    this.splitAddress = splitAddress;
  }

  setDistributeSplitResult(txHash: string): void {
    this.distributeSplitResult = txHash;
  }

  setSignX402Result(signature: Hex): void {
    this.signX402Result = signature;
  }

  reset(): void {
    this.address = FAKE_OPERATOR_ADDRESS;
    this.splitAddress = FAKE_SPLIT_ADDRESS;
    this.distributeSplitResult = FAKE_TX_HASH;
    this.signX402Result = FAKE_X402_SIGNATURE;
    this.lastDistributeSplitToken = undefined;
    this.lastX402Params = undefined;
  }
}

// ============================================================================
// Test Singleton Accessor (APP_ENV=test only)
// ============================================================================

let _testInstance: FakeOperatorWalletAdapter | null = null;

export function getTestOperatorWallet(): FakeOperatorWalletAdapter {
  if (!_testInstance) {
    _testInstance = new FakeOperatorWalletAdapter();
  }
  return _testInstance;
}

export function resetTestOperatorWallet(): void {
  if (_testInstance) {
    _testInstance.reset();
  }
}
