// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/splits-deploy`
 * Purpose: Experiment 2 — Deploy 0xSplits V2 push split on Base, distribute USDC.
 * Scope: Deploys a push split, sends USDC, triggers distribution, verifies shares. Does not modify production state.
 * Invariants: Base mainnet only; test wallet with small amounts only.
 * Side-effects: IO (network: Base RPC, deploys contract), process.env
 * Links: spike.0090
 * @internal — spike code, not for production use
 */

import { PUSH_SPLIT_V2o2_FACTORY_ADDRESS } from "@0xsplits/splits-sdk/constants";
import {
  splitV2ABI,
  splitV2o2FactoryAbi,
} from "@0xsplits/splits-sdk/constants/abi";

import type { Address } from "viem";
import { decodeEventLog, getAddress } from "viem";

import {
  createClients,
  ERC20_ABI,
  formatUsdc,
  getEnv,
  getUsdcBalance,
  logBalances,
  parseUsdc,
  USDC_ADDRESS,
} from "./shared";

// ---------------------------------------------------------------------------
// Split config
// ---------------------------------------------------------------------------

// 0xSplits V2 uses integer allocations with a totalAllocation denominator.
// Using 1_000_000 (1e6) as totalAllocation for precision.
const TOTAL_ALLOCATION = 1_000_000n;
const OPERATOR_ALLOCATION = 921_053n; // ~92.1% (operator share)
const TREASURY_ALLOCATION = TOTAL_ALLOCATION - OPERATOR_ALLOCATION; // ~7.9% (DAO share)

// Distribution incentive: reward for calling distribute() (in basis points of split balance).
// 0 = no incentive (we call it ourselves).
const DISTRIBUTION_INCENTIVE = 0;

// Amount to test with
const TEST_USDC_AMOUNT = "0.1"; // $0.10 USDC

// Push Split V2o2 Factory — same address on all chains (CREATE2)
const FACTORY_ADDRESS = getAddress(PUSH_SPLIT_V2o2_FACTORY_ADDRESS) as Address;

// CLI flags
const DISTRIBUTE_ONLY = process.argv.find((a) =>
  a.startsWith("--distribute-only=")
);
const EXISTING_SPLIT = DISTRIBUTE_ONLY
  ? (getAddress(DISTRIBUTE_ONLY.split("=")[1]) as Address)
  : undefined;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log(" Experiment 2: 0xSplits V2 Deploy + Distribute");
  console.log("═══════════════════════════════════════════════════\n");

  const env = getEnv();
  const { account, publicClient, walletClient } = createClients(env);

  const operatorAddress = account.address;
  const treasuryAddress = env.treasuryAddress;

  console.log(`[exp2] Operator (92.1%): ${operatorAddress}`);
  console.log(`[exp2] Treasury (7.9%):  ${treasuryAddress}`);
  console.log(`[exp2] Factory:          ${FACTORY_ADDRESS}`);

  // Pre-flight: check balances
  await logBalances(publicClient, operatorAddress, "Operator pre-flight");

  // Recipients must be sorted by address (ascending) for 0xSplits
  const recipientsSorted = [operatorAddress, treasuryAddress].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );

  // Allocations must match the sorted order
  const allocationsSorted = recipientsSorted.map((addr) =>
    addr.toLowerCase() === operatorAddress.toLowerCase()
      ? OPERATOR_ALLOCATION
      : TREASURY_ALLOCATION
  );

  const splitParams = {
    recipients: recipientsSorted as readonly Address[],
    allocations: allocationsSorted as readonly bigint[],
    totalAllocation: TOTAL_ALLOCATION,
    distributionIncentive: DISTRIBUTION_INCENTIVE,
  };

  console.log(`[exp2] Split params:`, {
    recipients: splitParams.recipients,
    allocations: splitParams.allocations.map(String),
    totalAllocation: String(splitParams.totalAllocation),
    distributionIncentive: splitParams.distributionIncentive,
  });

  let splitAddress: Address;
  let deployReceipt:
    | Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>
    | undefined;

  if (EXISTING_SPLIT) {
    // --distribute-only mode: skip deploy, reuse existing split
    splitAddress = EXISTING_SPLIT;
    console.log(`\n[exp2] Using existing split: ${splitAddress}`);
  } else {
    // Step 1: Deploy push split
    console.log(`\n[exp2] Deploying push split...`);

    // Simulate first
    const { result: predictedAddress } = await publicClient.simulateContract({
      address: FACTORY_ADDRESS,
      abi: splitV2o2FactoryAbi,
      functionName: "createSplit",
      args: [splitParams, operatorAddress, operatorAddress],
      account: operatorAddress,
    });

    console.log(`[exp2] Predicted split address: ${predictedAddress}`);

    // Deploy
    const deployHash = await walletClient.writeContract({
      address: FACTORY_ADDRESS,
      abi: splitV2o2FactoryAbi,
      functionName: "createSplit",
      args: [splitParams, operatorAddress, operatorAddress],
    });

    console.log(`[exp2] Deploy tx: ${deployHash}`);
    deployReceipt = await publicClient.waitForTransactionReceipt({
      hash: deployHash,
    });

    // Extract split address from SplitCreated event
    splitAddress = predictedAddress as Address;
    for (const log of deployReceipt.logs) {
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
        // Not our event, skip
      }
    }

    console.log(`\n[exp2] ═══ SPLIT DEPLOYED ═══`);
    console.log(`  address:     ${splitAddress}`);
    console.log(`  tx_hash:     ${deployReceipt.transactionHash}`);
    console.log(`  block:       ${deployReceipt.blockNumber}`);
    console.log(`  gas_used:    ${deployReceipt.gasUsed}`);
    console.log(`  status:      ${deployReceipt.status}`);
  }

  // Check split balance using plain ERC-20 balanceOf
  // (Push splits hold USDC as normal ERC-20 and distribute via direct transfers)
  const splitBalance = await getUsdcBalance(publicClient, splitAddress);
  console.log(`\n[exp2] Split USDC balance: ${formatUsdc(splitBalance)}`);

  // Step 2: Send USDC to the split (skip if balance already present)
  const usdcAmount = parseUsdc(TEST_USDC_AMOUNT);
  let sendReceipt:
    | Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>
    | undefined;

  if (splitBalance >= usdcAmount) {
    console.log(
      `[exp2] Split already has sufficient balance, skipping transfer`
    );
  } else {
    console.log(`\n[exp2] Sending ${TEST_USDC_AMOUNT} USDC to split...`);

    const sendHash = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [splitAddress, usdcAmount],
    });

    console.log(`[exp2] Transfer tx: ${sendHash}`);
    sendReceipt = await publicClient.waitForTransactionReceipt({
      hash: sendHash,
    });
    console.log(
      `[exp2] ✓ USDC sent. Gas: ${sendReceipt.gasUsed}, Status: ${sendReceipt.status}`
    );

    // Re-check split balance
    const splitBal2 = await getUsdcBalance(publicClient, splitAddress);
    console.log(
      `[exp2] Split balance after transfer: ${formatUsdc(splitBal2)}`
    );
  }

  // Step 3: Record pre-distribute balances
  const operatorBefore = await getUsdcBalance(publicClient, operatorAddress);
  const treasuryBefore = await getUsdcBalance(publicClient, treasuryAddress);

  console.log(`\n[exp2] Pre-distribute balances:`);
  console.log(`  Operator: ${formatUsdc(operatorBefore)}`);
  console.log(`  Treasury: ${formatUsdc(treasuryBefore)}`);

  // Step 4: Distribute
  console.log(`\n[exp2] Calling distribute()...`);

  // Push split V2: call distribute on the split contract itself.
  // distribute(_split, _token, _distributor) — distributes full balance
  const distributeHash = await walletClient.writeContract({
    address: splitAddress,
    abi: splitV2ABI,
    functionName: "distribute",
    args: [splitParams, USDC_ADDRESS, operatorAddress],
  });

  console.log(`[exp2] Distribute tx: ${distributeHash}`);
  const distributeReceipt = await publicClient.waitForTransactionReceipt({
    hash: distributeHash,
  });

  console.log(
    `[exp2] ✓ Distributed. Gas: ${distributeReceipt.gasUsed}, Status: ${distributeReceipt.status}`
  );

  // Step 5: Verify shares by checking post-distribute balances
  // Note: treasury delta is clean (only receives). Operator delta includes the outgoing
  // transfer to the split, so we verify by checking the split's remaining balance (should be ~dust)
  // and the treasury's delta (which is purely from the distribute).
  const operatorAfter = await getUsdcBalance(publicClient, operatorAddress);
  const treasuryAfter = await getUsdcBalance(publicClient, treasuryAddress);
  const splitAfter = await getUsdcBalance(publicClient, splitAddress);

  const treasuryDelta = treasuryAfter - treasuryBefore;

  const expectedOperator =
    (usdcAmount * OPERATOR_ALLOCATION) / TOTAL_ALLOCATION;
  const expectedTreasury =
    (usdcAmount * TREASURY_ALLOCATION) / TOTAL_ALLOCATION;

  // Operator net = received share - sent amount = expectedOperator - usdcAmount
  // (negative because operator funded the split in this test; in prod, users fund it)
  const operatorNet = operatorAfter - operatorBefore;

  console.log(`\n[exp2] ═══ DISTRIBUTION RESULT ═══`);
  console.log(`  Treasury received:  ${formatUsdc(treasuryDelta)}`);
  console.log(`  Treasury expected:  ${formatUsdc(expectedTreasury)}`);
  console.log(
    `  Treasury match:     ${treasuryDelta === expectedTreasury ? "✓ EXACT" : `⚠️  off by ${treasuryDelta - expectedTreasury}`}`
  );
  console.log(
    `  Operator net:       ${formatUsdc(operatorNet)} (sent ${formatUsdc(usdcAmount)}, got back ~${formatUsdc(expectedOperator)})`
  );
  console.log(`  Operator expected:  ${formatUsdc(expectedOperator)}`);
  console.log(
    `  Split remainder:    ${formatUsdc(splitAfter)} (should be ~dust)`
  );

  console.log(`\n[exp2] ═══ SPIKE FINDINGS ═══`);
  console.log(`  Split address:     ${splitAddress}`);
  console.log(`  Factory used:      PushSplitV2o2 (${FACTORY_ADDRESS})`);
  if (deployReceipt)
    console.log(`  Deploy gas:        ${deployReceipt.gasUsed}`);
  console.log(`  Distribute gas:    ${distributeReceipt.gasUsed}`);
  if (deployReceipt && sendReceipt) {
    console.log(
      `  Total gas:         ${deployReceipt.gasUsed + sendReceipt.gasUsed + distributeReceipt.gasUsed}`
    );
  }
  console.log(`  Push model works:  ${treasuryDelta > 0n ? "✓ YES" : "✗ NO"}`);

  // Save split address for experiment 3
  console.log(`\n[exp2] Save this for experiment 3:`);
  console.log(`  SPLIT_ADDRESS=${splitAddress}`);
}

main().catch((err) => {
  console.error("\n[exp2] FATAL:", err);
  process.exit(1);
});
