// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/deploy-split`
 * Purpose: Programmatic Push Split V2o2 deployment on Base via @0xsplits/splits-sdk.
 * Scope: CLI script that deploys a Split contract with operator/DAO allocations derived from billing constants. Outputs checksummed Split address + next steps. Does not modify repo-spec or app config — manual update required after deployment.
 * Invariants: Allocations derived from pricing constants (not hardcoded). Repeatable (idempotent on same params).
 * Side-effects: IO (deploys contract via Base RPC); stdout (prints address).
 * Links: https://node-template.cognidao.org/knowledge/operator-wallet-custody-boundary, spike.0090
 * @public
 */

import { PUSH_SPLIT_V2o2_FACTORY_ADDRESS } from "@0xsplits/splits-sdk/constants";
import { splitV2o2FactoryAbi } from "@0xsplits/splits-sdk/constants/abi";
import {
  calculateSplitAllocations,
  numberToPpm,
  OPENROUTER_CRYPTO_FEE_PPM,
  SPLIT_TOTAL_ALLOCATION,
} from "@cogni/operator-wallet";
import type { Address } from "viem";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
  return val;
}

async function main(): Promise<void> {
  // --- Config from env ---
  const operatorAddress = getAddress(
    requireEnv("OPERATOR_WALLET_ADDRESS")
  ) as Address;
  const treasuryAddress = getAddress(
    requireEnv("DAO_TREASURY_ADDRESS")
  ) as Address;
  const markupPpm = numberToPpm(
    Number(process.env.USER_PRICE_MARKUP_FACTOR ?? "2.0")
  );
  const revenueSharePpm = numberToPpm(
    Number(process.env.SYSTEM_TENANT_REVENUE_SHARE ?? "0.75")
  );

  // Private key for deploying (operator wallet or deployer EOA)
  const rawKey = requireEnv("DEPLOYER_PRIVATE_KEY");
  const privateKey = (
    rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`
  ) as `0x${string}`;
  const account = privateKeyToAccount(privateKey);

  const rpcUrl =
    process.env.EVM_RPC_URL ??
    process.env.BASE_RPC_URL ??
    "https://mainnet.base.org";

  // --- Derive allocations ---
  const { operatorAllocation, treasuryAllocation } = calculateSplitAllocations(
    markupPpm,
    revenueSharePpm,
    OPENROUTER_CRYPTO_FEE_PPM
  );

  console.log("═══════════════════════════════════════════════════");
  console.log(" Deploy Push Split V2o2 on Base");
  console.log("═══════════════════════════════════════════════════\n");
  console.log(
    `  Operator (${Number(operatorAllocation) / 1e4}%): ${operatorAddress}`
  );
  console.log(
    `  Treasury (${Number(treasuryAllocation) / 1e4}%): ${treasuryAddress}`
  );
  console.log(`  Deployer:    ${account.address}`);
  console.log(`  Markup:      ${Number(markupPpm) / 1e6}x`);
  console.log(`  RevShare:    ${Number(revenueSharePpm) / 1e6}`);
  console.log(`  ProviderFee: ${Number(OPENROUTER_CRYPTO_FEE_PPM) / 1e6}`);

  // --- Clients ---
  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });

  // --- Sort recipients (0xSplits requires ascending address order) ---
  const entries = [
    { address: operatorAddress, allocation: operatorAllocation },
    { address: treasuryAddress, allocation: treasuryAllocation },
  ].sort((a, b) =>
    a.address.toLowerCase().localeCompare(b.address.toLowerCase())
  );

  const splitParams = {
    recipients: entries.map((e) => e.address) as readonly Address[],
    allocations: entries.map((e) => e.allocation) as readonly bigint[],
    totalAllocation: SPLIT_TOTAL_ALLOCATION,
    distributionIncentive: 0,
  };

  const factoryAddress = getAddress(PUSH_SPLIT_V2o2_FACTORY_ADDRESS) as Address;

  // --- Simulate ---
  console.log("\nSimulating createSplit...");
  const { result: predictedAddress } = await publicClient.simulateContract({
    address: factoryAddress,
    abi: splitV2o2FactoryAbi,
    functionName: "createSplit",
    args: [splitParams, operatorAddress, operatorAddress],
    account: account.address,
  });
  console.log(`Predicted address: ${predictedAddress}`);

  // --- Deploy ---
  console.log("Broadcasting createSplit...");
  const deployHash = await walletClient.writeContract({
    address: factoryAddress,
    abi: splitV2o2FactoryAbi,
    functionName: "createSplit",
    args: [splitParams, operatorAddress, operatorAddress],
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: deployHash,
  });

  // Extract address from SplitCreated event
  let splitAddress: string = predictedAddress as string;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: splitV2o2FactoryAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === "SplitCreated") {
        splitAddress = (decoded.args as { split: Address }).split;
        break;
      }
    } catch {
      // Not our event
    }
  }

  console.log("\n═══════════════════════════════════════════════════");
  console.log(" SPLIT DEPLOYED");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Address:  ${splitAddress}`);
  console.log(`  Tx:       ${receipt.transactionHash}`);
  console.log(`  Gas:      ${receipt.gasUsed}`);
  console.log(`  Block:    ${receipt.blockNumber}`);
  console.log();
  console.log("Next steps:");
  console.log(
    `  1. Update .cogni/repo-spec.yaml → payments_in.credits_topup.receiving_address = "${splitAddress}"`
  );
  console.log(`  2. Fund the operator wallet with ETH for gas on Base`);
  console.log(
    `  3. Test: send USDC to ${splitAddress}, then call distributeSplit()`
  );
}

main().catch((err) => {
  console.error("Failed to deploy split:", err);
  process.exit(1);
});
