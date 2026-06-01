// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ports/wallet.viem.adapter`
 * Purpose: Verifies Viem wallet adapter compliance with WalletPort contract using stub implementation.
 * Scope: Covers address retrieval, message signing, and signature verification; does not cover real Viem integration.
 * Invariants: Adapter passes all WalletPort contract tests; signatures are deterministic for testing.
 * Side-effects: none
 * Notes: Uses stub implementation until real Viem adapter is implemented.
 * Links: WalletPort contract, tests/ports/harness/wallet.port.harness.ts
 * @internal
 */

import type { TestHarness } from "./harness/factory";
import {
  registerWalletPortContract,
  type WalletPort,
} from "./harness/wallet.port.harness";

// Stub implementation of WalletPort using "Viem"
class StubViemWalletPort implements WalletPort {
  private readonly stubAddress = "0x742d35Cc6635C0532925a3b8D8c98cdD3c5C9042";
  private readonly stubPrivateKey = "stub-private-key";

  async getAddress(): Promise<string> {
    // TODO: Replace with real Viem wallet.getAddress()
    return this.stubAddress;
  }

  async signMessage(message: string): Promise<string> {
    // TODO: Replace with real Viem wallet.signMessage()
    return `stub-signature-for-${message}-with-${this.stubPrivateKey}`;
  }

  async verifySignature(
    message: string,
    signature: string,
    address: string
  ): Promise<boolean> {
    // TODO: Replace with real Viem signature verification
    const expectedSignature = await this.signMessage(message);
    return signature === expectedSignature && address === this.stubAddress;
  }
}

function makeViemWalletPort(_harness: TestHarness): Promise<WalletPort> {
  // TODO: Initialize real Viem wallet from harness config
  return Promise.resolve(new StubViemWalletPort());
}

// Register the contract tests with our stub adapter
registerWalletPortContract(makeViemWalletPort);
