// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/poly-privy-per-user-spike/1-create-wallet`
 * Purpose: Provisions a FRESH per-user Privy wallet (distinct from the shared operator wallet) to prove the per-user wallet provisioning flow for task.0318 Phase B.
 * Scope: CLI script. Does not modify repo-spec or any persistent state beyond Privy.
 *   Prints the new wallet's `address` + `walletId` for use in spike steps 2-6.
 * Invariants: KEY_NEVER_IN_APP — no private key material emitted or stored.
 * Side-effects: IO (creates wallet via Privy API); stdout (prints address + id).
 * Links: https://poly.cognidao.org/knowledge/poly-tenant-wallet-authorization,
 *        scripts/provision-operator-wallet.ts (pattern source)
 * @internal
 */

import { PrivyClient } from "@privy-io/node";

async function main(): Promise<void> {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;

  if (!appId || !appSecret) {
    console.error("Missing required env: PRIVY_APP_ID, PRIVY_APP_SECRET");
    console.error("Reuse the values from your operator-wallet .env.local.");
    process.exit(1);
  }

  const client = new PrivyClient({ appId, appSecret });

  console.log("[spike] Creating a NEW per-user Privy wallet candidate...");
  console.log(
    "[spike] This is NOT the operator wallet — it simulates a user's Polymarket wallet.\n"
  );

  const wallet = await client.wallets().create({ chain_type: "ethereum" });

  console.log("[spike] Per-user wallet candidate provisioned.");
  console.log(`[spike]   address:  ${wallet.address}`);
  console.log(`[spike]   walletId: ${wallet.id}`);
  console.log();
  console.log("Next:");
  console.log(`  1. Record address + walletId in evidence/wallet-provision.md`);
  console.log(
    `  2. Fund the address with ~$5 USDC.e + ~0.2 MATIC on Polygon (see README)`
  );
  console.log(
    `  3. Run approvals with: POLY_PROTO_WALLET_ADDRESS=${wallet.address} PRIVY_WALLET_ID=${wallet.id} tsx scripts/experiments/approve-polymarket-allowances.ts`
  );
}

main().catch((err) => {
  console.error("[spike] Failed to provision per-user wallet:", err);
  process.exit(1);
});
