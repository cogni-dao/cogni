// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/privy/operator-wallet-provisioner`
 * Purpose: Server-side Privy wallet creation, lifted from `scripts/provision-operator-wallet.ts`.
 * Scope: Single entry point that creates a Privy-managed Ethereum wallet under operator's Privy app and
 *   returns the checksummed address + Privy wallet id. Does not modify the database — callers persist
 *   the result onto the `nodes` row.
 * Invariants: KEY_NEVER_LEAVES_PRIVY — the private key is held by Privy; we only receive the address.
 * Side-effects: IO (Privy API)
 * Links: scripts/provision-operator-wallet.ts (CLI parity), docs/spec/operator-wallet.md, task.5083
 * @internal
 */

import { PrivyClient } from "@privy-io/node";

export interface ProvisionOperatorWalletConfig {
  readonly appId: string;
  readonly appSecret: string;
}

export interface ProvisionedOperatorWallet {
  readonly address: string;
  readonly privyWalletId: string;
}

export async function provisionOperatorWallet(
  config: ProvisionOperatorWalletConfig
): Promise<ProvisionedOperatorWallet> {
  const client = new PrivyClient({
    appId: config.appId,
    appSecret: config.appSecret,
  });

  const wallet = await client.wallets().create({ chain_type: "ethereum" });

  return {
    address: wallet.address,
    privyWalletId: wallet.id,
  };
}
