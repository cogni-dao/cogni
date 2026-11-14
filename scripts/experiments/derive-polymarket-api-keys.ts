// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/derive-polymarket-api-keys`
 * Purpose: task.0315 Phase 1 Prereq-B — derive Polymarket L2 CLOB API credentials (key / secret / passphrase) for the operator Privy wallet. Emits creds as shell-pasteable env-var lines. Run once per wallet; re-running returns the same creds via `createOrDeriveApiKey`.
 * Scope: Hits `POST /auth/api-key` (or `/auth/derive-api-key`) signed by the Privy HSM wallet via `@privy-io/node/viem` + `@polymarket/clob-client`. Does not place orders, move funds, accept ToS, or persist creds — caller copies output into .env.local.
 * Invariants: Polygon chainId 137 only; reuses the same Privy creds as sign-polymarket-order experiment. Not for production runtime use.
 * Side-effects: IO (reads .env.local; lists Privy wallets via HTTPS; one signed request to Polymarket CLOB auth endpoint).
 * Links: https://poly.cognidao.org/knowledge/poly-tenant-wallet-authorization
 * @internal — experiment code, not shipped to production
 */

import path from "node:path";
import { ClobClient } from "@polymarket/clob-client";
import { PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import { config } from "dotenv";
import { createWalletClient, type Hex, http } from "viem";
import { polygon } from "viem/chains";

config({ path: path.resolve(__dirname, "../../.env.local") });
config({ path: path.resolve(__dirname, ".env") });

const POLYGON_CHAIN_ID = 137;
const CLOB_HOST = "https://clob.polymarket.com";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`[prereq-b] Missing required env var: ${key}`);
    process.exit(1);
  }
  return val;
}

async function main(): Promise<void> {
  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");
  const signingKey = requireEnv("PRIVY_SIGNING_KEY");
  const expectedAddress = requireEnv("OPERATOR_WALLET_ADDRESS") as Hex;

  console.log("[prereq-b] Resolving Privy walletId...");
  const privy = new PrivyClient({ appId, appSecret });
  let walletId: string | undefined;
  for await (const wallet of privy.wallets().list()) {
    if (wallet.address.toLowerCase() === expectedAddress.toLowerCase()) {
      walletId = wallet.id;
      break;
    }
  }
  if (!walletId) {
    console.error(
      `[prereq-b] FAIL: no Privy wallet matches ${expectedAddress}`
    );
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

  console.log(
    `[prereq-b] Deriving/creating L2 API creds for ${expectedAddress}...`
  );
  const clob = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, walletClient);
  const creds = await clob.createOrDeriveApiKey();

  console.log("[prereq-b] PASS — creds ready. Paste into .env.local:");
  console.log("");
  console.log(`POLY_CLOB_API_KEY=${creds.key}`);
  console.log(`POLY_CLOB_API_SECRET=${creds.secret}`);
  console.log(`POLY_CLOB_PASSPHRASE=${creds.passphrase}`);
  console.log("");
  console.log(
    "[prereq-b] Store secret + passphrase in 1Password as well. Re-running this script returns the same creds — idempotent."
  );
}

main().catch((err: unknown) => {
  console.error("[prereq-b] unhandled error:", err);
  process.exit(1);
});
