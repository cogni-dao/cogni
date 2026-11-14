// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/probe-polymarket-account`
 * Purpose: task.0315 Phase 1 Prereq-A probe — ask Polymarket whether the operator EOA is known to the CLOB, what address owns the funded-balance check, and whether a Safe proxy is in play. Does not deposit, onboard, or modify anything.
 * Scope: Runs authenticated reads (`getApiKeys`, `getBalanceAllowance`) to infer the account model that applies to this wallet. Does not submit orders, accept ToS, or move funds.
 * Invariants: Polygon chainId 137; reuses existing Privy creds + just-derived POLY_CLOB_API_* creds.
 * Side-effects: IO (reads .env.local; two authenticated HTTPS calls to Polymarket CLOB).
 * Links: https://poly.cognidao.org/knowledge/poly-wallet-trading-lessons
 * @internal — probe code, not shipped to production
 */

import path from "node:path";
import { AssetType, ClobClient } from "@polymarket/clob-client";
import { PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import { config } from "dotenv";
import { createWalletClient, type Hex, http } from "viem";
import { polygon } from "viem/chains";

config({ path: path.resolve(__dirname, "../../.env.local") });

const POLYGON_CHAIN_ID = 137;
const CLOB_HOST = "https://clob.polymarket.com";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`[probe] Missing: ${key}`);
    process.exit(1);
  }
  return val;
}

async function main(): Promise<void> {
  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");
  const signingKey = requireEnv("PRIVY_SIGNING_KEY");
  const expectedAddress = requireEnv("OPERATOR_WALLET_ADDRESS") as Hex;
  const creds = {
    key: requireEnv("POLY_CLOB_API_KEY"),
    secret: requireEnv("POLY_CLOB_API_SECRET"),
    passphrase: requireEnv("POLY_CLOB_PASSPHRASE"),
  };

  const privy = new PrivyClient({ appId, appSecret });
  let walletId: string | undefined;
  for await (const w of privy.wallets().list()) {
    if (w.address.toLowerCase() === expectedAddress.toLowerCase()) {
      walletId = w.id;
      break;
    }
  }
  if (!walletId) {
    console.error("[probe] No Privy wallet matches operator EOA");
    process.exit(1);
  }

  const account = createViemAccount(privy, {
    walletId,
    address: expectedAddress,
    authorizationContext: { authorization_private_keys: [signingKey] },
  });
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  const clob = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, walletClient, creds);

  console.log("[probe] EOA:", expectedAddress);
  console.log("[probe] --- getApiKeys ---");
  try {
    const keys = await clob.getApiKeys();
    console.log(JSON.stringify(keys, null, 2));
  } catch (err) {
    console.error("[probe] getApiKeys failed:", (err as Error).message);
  }

  console.log(
    "[probe] --- getBalanceAllowance COLLATERAL (default signatureType=EOA) ---"
  );
  try {
    const bal = await clob.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    console.log(JSON.stringify(bal, null, 2));
  } catch (err) {
    console.error(
      "[probe] getBalanceAllowance failed:",
      (err as Error).message
    );
  }
}

main().catch((err: unknown) => {
  console.error("[probe] unhandled:", err);
  process.exit(1);
});
