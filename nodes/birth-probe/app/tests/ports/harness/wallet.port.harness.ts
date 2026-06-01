// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ports/harness/wallet.port`
 * Purpose: Shared contract tests for Wallet port implementations ensuring consistent behavior across adapters.
 * Scope: Covers wallet address retrieval, message signing, and signature verification; does not test specific adapter implementations.
 * Invariants: All wallet adapters pass contract tests; signatures are verifiable with corresponding addresses.
 * Side-effects: none
 * Notes: Called from adapter specs; not executed directly by Vitest. Contains stub tests until real port is defined.
 * Links: WalletPort interface, tests/ports/wallet.*.adapter.spec.ts
 * @internal
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dispose, makeHarness, type TestHarness } from "./factory";

export interface WalletPort {
  // stub for now – align with src/ports/wallet.port.ts once it exists
  signMessage(message: string): Promise<string>;
  verifySignature(
    message: string,
    signature: string,
    address: string
  ): Promise<boolean>;
  getAddress(): Promise<string>;
}

/**
 * Register the Wallet port contract tests.
 * Adapter specs call this with a factory that builds a WalletPort
 * using the provided TestHarness (db, stubs, etc.).
 */
export function registerWalletPortContract(
  makeWalletPort: (h: TestHarness) => Promise<WalletPort>
): void {
  describe("Wallet Port Contract", () => {
    let h: TestHarness;
    let port: WalletPort;

    beforeAll(async () => {
      h = await makeHarness(); // add options if you need stubs
      port = await makeWalletPort(h);
    });

    afterAll(async () => {
      await dispose(h);
    });

    it("returns a valid address (stub)", async () => {
      const address = await port.getAddress();
      expect(typeof address).toBe("string");
      expect(address.length).toBeGreaterThan(0);
    });

    it("signs messages consistently (stub)", async () => {
      const message = "test message";
      const signature = await port.signMessage(message);
      expect(typeof signature).toBe("string");
      expect(signature.length).toBeGreaterThan(0);
    });

    it("verifies signatures correctly (stub)", async () => {
      const message = "test message";
      const signature = await port.signMessage(message);
      const address = await port.getAddress();
      const isValid = await port.verifySignature(message, signature, address);
      expect(isValid).toBe(true);
    });

    // TODO: add real invariants once port is defined
    // - signature verification works
    // - message signing works
    // - error handling is consistent
    // - address validation works
  });
}
