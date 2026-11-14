// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/distribute-split`
 * Purpose: Manual trigger for Split contract USDC distribution via Privy operator wallet.
 * Scope: CLI script that calls distributeSplit() on a deployed Push Split V2o2. Does not modify repo-spec or app config — distributes accumulated USDC to operator + DAO treasury.
 * Invariants: KEY_NEVER_IN_APP — Privy HSM signs the transaction. Uses splitV2ABI (not manual selectors).
 * Side-effects: IO (submits distribute tx via Privy API); stdout (prints txHash).
 * Links: https://node-template.cognidao.org/knowledge/operator-wallet-custody-boundary, task.0085
 * @public
 */

import { PrivyOperatorWalletAdapter } from "@cogni/operator-wallet/adapters/privy";
import { getAddress } from "viem";

/** USDC on Base mainnet */
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
  return val;
}

async function main(): Promise<void> {
  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");
  const signingKey = requireEnv("PRIVY_SIGNING_KEY");
  const operatorAddress = getAddress(requireEnv("OPERATOR_WALLET_ADDRESS"));
  const splitAddress = getAddress(requireEnv("SPLIT_ADDRESS"));
  const treasuryAddress = getAddress(requireEnv("DAO_TREASURY_ADDRESS"));
  const { numberToPpm } = await import("@cogni/operator-wallet");
  const markupPpm = numberToPpm(
    Number(process.env.USER_PRICE_MARKUP_FACTOR ?? "2.0")
  );
  const revenueSharePpm = numberToPpm(
    Number(process.env.SYSTEM_TENANT_REVENUE_SHARE ?? "0.75")
  );

  console.log("═══════════════════════════════════════════════════");
  console.log(" Distribute Split — Push Split V2o2 on Base");
  console.log("═══════════════════════════════════════════════════\n");
  console.log(`  Split:     ${splitAddress}`);
  console.log(`  Operator:  ${operatorAddress}`);
  console.log(`  Treasury:  ${treasuryAddress}`);
  console.log(`  Token:     USDC (${BASE_USDC_ADDRESS})`);
  console.log(`  Markup:    ${Number(markupPpm) / 1e6}x`);
  console.log(`  RevShare:  ${Number(revenueSharePpm) / 1e6}`);

  const adapter = new PrivyOperatorWalletAdapter({
    appId,
    appSecret,
    signingKey,
    expectedAddress: operatorAddress,
    splitAddress,
    treasuryAddress,
    markupPpm,
    revenueSharePpm,
  });

  console.log("\nSubmitting distribute transaction...");
  const txHash = await adapter.distributeSplit(BASE_USDC_ADDRESS);

  console.log("\n═══════════════════════════════════════════════════");
  console.log(" DISTRIBUTION COMPLETE");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  TxHash:  ${txHash}`);
  console.log(`  Explorer: https://basescan.org/tx/${txHash}`);
  console.log();
  console.log("USDC distributed to operator wallet + DAO treasury.");
}

main().catch((err) => {
  console.error("Failed to distribute split:", err);
  process.exit(1);
});
