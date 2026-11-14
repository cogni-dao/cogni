// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/provision-poly-proto-wallet`
 * Purpose: Create a NEW Privy-managed wallet dedicated to the task.0315
 *   Polymarket copy-trade prototype. Custody-isolated from the production
 *   billing operator wallet (`OPERATOR_WALLET_ADDRESS`) used by
 *   distributeSplit / fundOpenRouterTopUp.
 * Scope: One-shot CLI. Does not fund the wallet or approve allowances (those are separate scripts). Reads PRIVY_APP_ID/_SECRET/_SIGNING_KEY from the
 *   existing .env.local (same Privy app as the billing wallet — address-level
 *   isolation only; full app-level isolation is a future hardening). Creates
 *   a new wallet and prints env-var lines to paste into .env.local. Does not
 *   fund the wallet or approve any allowances — those are separate scripts.
 * Invariants: KEY_NEVER_IN_APP — no private key material emitted. Does NOT
 *   modify .cogni/repo-spec.yaml (prototype, not a node payment activation).
 * Side-effects: IO (Privy API, stdout)
 * Links: https://poly.cognidao.org/knowledge/poly-tenant-wallet-runbook
 * @public
 */

import { PrivyClient } from "@privy-io/node";

async function main(): Promise<void> {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  const signingKey = process.env.PRIVY_SIGNING_KEY;

  if (!appId || !appSecret || !signingKey) {
    console.error(
      "Missing required env vars: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_SIGNING_KEY"
    );
    console.error(
      "Run with: pnpm dotenv -e .env.local -- pnpm tsx scripts/provision-poly-proto-wallet.ts"
    );
    process.exit(1);
  }

  // Owner = key quorum controlled by POLY_PROTO_PRIVY_SIGNING_KEY
  // (programmatic ownership). Without this, the wallet defaults to a
  // dashboard-user owner and becomes unsignable from API.
  const ownerId = process.env.POLY_PROTO_OWNER_QUORUM_ID;
  if (!ownerId) {
    console.error(
      "[poly-proto] Missing POLY_PROTO_OWNER_QUORUM_ID — set this to the Privy key-quorum id whose public key pairs with POLY_PROTO_PRIVY_SIGNING_KEY"
    );
    process.exit(1);
  }

  const client = new PrivyClient({ appId, appSecret });

  console.log(
    "[poly-proto] Creating dedicated Polymarket prototype wallet via Privy..."
  );
  console.log(
    `[poly-proto] (owner = key quorum ${ownerId}; custody-isolated from production)`
  );

  const wallet = await (
    client.wallets() as unknown as {
      create: (params: {
        chain_type: string;
        owner_id?: string;
        display_name?: string;
      }) => Promise<{ id: string; address: string }>;
    }
  ).create({
    chain_type: "ethereum",
    owner_id: ownerId,
    display_name: "poly-trading-prototype-v2",
  });

  console.log("");
  console.log("[poly-proto] PASS — wallet created.");
  console.log(`  Address:   ${wallet.address}`);
  console.log(`  Wallet ID: ${wallet.id}`);
  console.log("");
  console.log("Paste into .env.local:");
  console.log("");
  console.log(`POLY_PROTO_WALLET_ADDRESS=${wallet.address}`);
  console.log("");
  console.log("Next steps (per task.0315 CP4.25 isolation plan):");
  console.log(
    `  1. Fund ${wallet.address} with ~$20 USDC.e + ~$0.50 MATIC on Polygon (chainId 137)`
  );
  console.log(
    "  2. Generate a per-wallet authorization key in the Privy dashboard for"
  );
  console.log(
    "     this wallet, save into .env.local as POLY_PROTO_PRIVY_SIGNING_KEY"
  );
  console.log("  3. Run CP3.1 allowances against this address:");
  console.log(`     OPERATOR_WALLET_ADDRESS=${wallet.address} \\`);
  console.log("       PRIVY_SIGNING_KEY=$POLY_PROTO_PRIVY_SIGNING_KEY \\");
  console.log(
    "       pnpm dotenv -e .env.local -- pnpm tsx scripts/experiments/approve-polymarket-allowances.ts"
  );
  console.log("  4. Derive Polymarket L2 CLOB API creds against this address:");
  console.log(`     OPERATOR_WALLET_ADDRESS=${wallet.address} \\`);
  console.log("       PRIVY_SIGNING_KEY=$POLY_PROTO_PRIVY_SIGNING_KEY \\");
  console.log(
    "       pnpm dotenv -e .env.local -- pnpm tsx scripts/experiments/derive-polymarket-api-keys.ts"
  );
  console.log(
    "  5. Save POLY_CLOB_API_KEY/_SECRET/_PASSPHRASE into .env.local"
  );
  console.log(
    "  6. Propagate POLY_PROTO_WALLET_ADDRESS + POLY_PROTO_PRIVY_SIGNING_KEY"
  );
  console.log("     + POLY_CLOB_* to GH candidate-a env via `gh secret set`");
}

main().catch((err) => {
  console.error("[poly-proto] Failed to provision prototype wallet:", err);
  process.exit(1);
});
