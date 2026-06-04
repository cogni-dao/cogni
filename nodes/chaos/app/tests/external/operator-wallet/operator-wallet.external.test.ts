// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/tests/external/operator-wallet/operator-wallet.external.test`
 * Purpose: Validate PrivyOperatorWalletAdapter against real Privy API + deployed Split contract.
 * Scope: Tests wallet verification, address lookup, and distributeSplit() against Base mainnet.
 * Invariants: Requires PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_SIGNING_KEY in env. Skips gracefully if missing.
 * Side-effects: IO (Privy API, Base RPC — each distributeSplit() call costs gas on Base mainnet)
 * Links: packages/operator-wallet/src/adapters/privy/privy-operator-wallet.adapter.ts, docs/spec/operator-wallet.md
 * @internal
 */

import { numberToPpm } from "@cogni/operator-wallet";
import { PrivyOperatorWalletAdapter } from "@cogni/operator-wallet/adapters/privy";
import { describe, expect, it } from "vitest";

const PRIVY_APP_ID = process.env.PRIVY_APP_ID ?? "";
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET ?? "";
const PRIVY_SIGNING_KEY = process.env.PRIVY_SIGNING_KEY ?? "";

const OPERATOR_ADDRESS = "0xdCCa8D85603C2CC47dc6974a790dF846f8695056";
const SPLIT_ADDRESS = "0xd92EEc51C471CcF76996f0163Fd3cB6A61798f9C";
const DAO_TREASURY = "0xF61c808831CDB8fCCA22160768B711893fA9a3a0";

// USDC on Base
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const skip = !PRIVY_APP_ID || !PRIVY_APP_SECRET || !PRIVY_SIGNING_KEY;

describe.skipIf(skip)("PrivyOperatorWalletAdapter (external)", () => {
  const adapter = new PrivyOperatorWalletAdapter({
    appId: PRIVY_APP_ID,
    appSecret: PRIVY_APP_SECRET,
    signingKey: PRIVY_SIGNING_KEY,
    expectedAddress: OPERATOR_ADDRESS,
    splitAddress: SPLIT_ADDRESS,
    treasuryAddress: DAO_TREASURY,
    markupPpm: numberToPpm(2.0),
    revenueSharePpm: numberToPpm(0.75),
  });

  it("getAddress() returns expected operator address after Privy verification", async () => {
    const address = await adapter.getAddress();
    expect(address.toLowerCase()).toBe(OPERATOR_ADDRESS.toLowerCase());
  });

  it("getSplitAddress() returns deployed Split address", () => {
    expect(adapter.getSplitAddress().toLowerCase()).toBe(
      SPLIT_ADDRESS.toLowerCase()
    );
  });

  it("distributeSplit(USDC) submits tx via Privy HSM", async () => {
    // Requires the Privy wallet to be funded with ETH on Base for gas.
    // distribute() with 0 USDC balance is a no-op (not a revert).
    const txHash = await adapter.distributeSplit(USDC_BASE);
    expect(txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    console.log(`distributeSplit tx: ${txHash}`);
  }, 30_000);
});
