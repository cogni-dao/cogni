// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/full-chain`
 * Purpose: Experiment 3 — End-to-end: USDC → Split → operator wallet → OpenRouter credits.
 * Scope: Proves the full payment chain works. Does not modify production state; requires experiments 1 & 2 validated first.
 * Invariants: Base mainnet only; test wallet with small amounts only; SPLIT_ADDRESS must be set.
 * Side-effects: IO (network: OpenRouter API + Base RPC), process.env
 * Links: spike.0090
 * @internal — spike code, not for production use
 */

import { splitV2ABI } from "@0xsplits/splits-sdk/constants/abi";

import type { Address, Hex } from "viem";

import {
  createClients,
  ERC20_ABI,
  getEnv,
  logBalances,
  parseUsdc,
  TRANSFERS_ABI,
  USDC_ADDRESS,
} from "./shared";

// ---------------------------------------------------------------------------
// Config — must match experiment 2
// ---------------------------------------------------------------------------

const TOTAL_ALLOCATION = 1_000_000n;
const OPERATOR_ALLOCATION = 921_053n;
const TREASURY_ALLOCATION = TOTAL_ALLOCATION - OPERATOR_ALLOCATION;
const DISTRIBUTION_INCENTIVE = 0;

const TEST_USDC_AMOUNT = "0.1"; // $0.10 USDC

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

function requireSplitAddress(): Address {
  const addr = process.env.SPLIT_ADDRESS;
  if (!addr) {
    console.error(
      `[exp3] Missing SPLIT_ADDRESS env var. Run experiment 2 first and set SPLIT_ADDRESS.`
    );
    process.exit(1);
  }
  return addr as Address;
}

// ---------------------------------------------------------------------------
// OpenRouter helpers (duplicated from exp1 for self-containment)
// ---------------------------------------------------------------------------

interface TransferIntentCallData {
  recipient_amount: string;
  deadline: string;
  recipient: string;
  recipient_currency: string;
  refund_destination: string;
  fee_amount: string;
  id: string;
  operator: string;
  signature: string;
  prefix: string;
}

interface TransferIntentMetadata {
  chain_id: number;
  contract_address: string;
  sender: string;
}

interface CoinbaseChargeResponse {
  data: {
    id: string;
    created_at: string;
    expires_at: string;
    web3_data: {
      transfer_intent: {
        call_data: TransferIntentCallData;
        metadata: TransferIntentMetadata;
      };
    };
  };
}

interface CreditsResponse {
  data: {
    total_credits: number;
    total_usage: number;
  };
}

async function createCharge(
  apiKey: string,
  sender: Address,
  amount: number
): Promise<CoinbaseChargeResponse> {
  const res = await fetch("https://openrouter.ai/api/v1/credits/coinbase", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ amount, sender, chain_id: 8453 }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter charge failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<CoinbaseChargeResponse>;
}

async function getCredits(apiKey: string): Promise<number> {
  const res = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch credits: ${res.status}`);
  const data = (await res.json()) as CreditsResponse;
  return data.data.total_credits;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log(" Experiment 3: Full Chain (Split → Wallet → OR)");
  console.log("═══════════════════════════════════════════════════\n");

  const startTime = Date.now();
  const env = getEnv();
  const { account, publicClient, walletClient } = createClients(env);

  const operatorAddress = account.address;
  const treasuryAddress = env.treasuryAddress;
  const splitAddress = requireSplitAddress();

  console.log(`[exp3] Split:    ${splitAddress}`);
  console.log(`[exp3] Operator: ${operatorAddress}`);
  console.log(`[exp3] Treasury: ${treasuryAddress}`);

  // Pre-flight
  await logBalances(publicClient, operatorAddress, "Operator pre-flight");
  const creditsBefore = await getCredits(env.openrouterApiKey);
  console.log(`[exp3] OpenRouter credits before: $${creditsBefore.toFixed(4)}`);

  // ─── Step 1: Send USDC to Split ──────────────────────────────────
  console.log(`\n[exp3] Step 1: Sending ${TEST_USDC_AMOUNT} USDC to split...`);

  const usdcAmount = parseUsdc(TEST_USDC_AMOUNT);
  const sendHash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [splitAddress, usdcAmount],
  });

  const sendReceipt = await publicClient.waitForTransactionReceipt({
    hash: sendHash,
  });
  console.log(`[exp3] ✓ Sent. Tx: ${sendHash}`);

  // ─── Step 2: Distribute from Split ───────────────────────────────
  console.log(`\n[exp3] Step 2: Distributing from split...`);

  const recipientsSorted = [operatorAddress, treasuryAddress].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
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

  // Brief wait for RPC to catch up (avoids stale-read reverts seen in exp2)
  await new Promise((r) => setTimeout(r, 2_000));

  const distributeHash = await walletClient.writeContract({
    address: splitAddress,
    abi: splitV2ABI,
    functionName: "distribute",
    args: [splitParams, USDC_ADDRESS, operatorAddress],
  });

  const distributeReceipt = await publicClient.waitForTransactionReceipt({
    hash: distributeHash,
  });
  console.log(
    `[exp3] ✓ Distributed. Gas: ${distributeReceipt.gasUsed}, Status: ${distributeReceipt.status}`
  );

  // ─── Step 3: OpenRouter top-up from operator wallet ──────────────
  // Use $1 charge (requires 1.05 USDC including 5% fee).
  // The operator share from $0.10 is only ~$0.09 — not enough for a $1 charge.
  // But the operator wallet has accumulated USDC from previous experiments.
  const TOP_UP_AMOUNT_USD = 1;
  console.log(
    `\n[exp3] Step 3: Creating OpenRouter charge ($${TOP_UP_AMOUNT_USD})...`
  );

  const charge = await createCharge(
    env.openrouterApiKey,
    operatorAddress,
    TOP_UP_AMOUNT_USD
  );
  const { metadata, call_data } = charge.data.web3_data.transfer_intent;

  console.log(`[exp3] Charge created: ${charge.data.id}`);
  console.log(`[exp3] Contract: ${metadata.contract_address}`);

  const contractAddress = metadata.contract_address as Address;

  // Parse deadline: ISO 8601 string → unix timestamp
  const deadlineNum = /^\d+$/.test(call_data.deadline)
    ? BigInt(call_data.deadline)
    : BigInt(Math.floor(new Date(call_data.deadline).getTime() / 1000));

  const intent = {
    recipientAmount: BigInt(call_data.recipient_amount),
    deadline: deadlineNum,
    recipient: call_data.recipient as Address,
    recipientCurrency: call_data.recipient_currency as Address,
    refundDestination: call_data.refund_destination as Address,
    feeAmount: BigInt(call_data.fee_amount),
    id: call_data.id as Hex,
    operator: call_data.operator as Address,
    signature: call_data.signature as Hex,
    prefix: call_data.prefix as Hex,
  };

  const totalUsdc = intent.recipientAmount + intent.feeAmount;
  console.log(
    `[exp3] Total USDC needed: ${Number(totalUsdc) / 1e6} (${Number(intent.recipientAmount) / 1e6} + ${Number(intent.feeAmount) / 1e6} fee)`
  );

  // transferTokenPreApproved uses direct ERC-20 transferFrom (NOT Permit2).
  // Source: Transfers.sol checks erc20.allowance(msg.sender, address(this))
  console.log(
    `[exp3] Approving USDC to Transfers contract (${contractAddress})...`
  );
  const approveHash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [contractAddress, totalUsdc],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`[exp3] ✓ Approval confirmed`);

  // Simulate
  console.log(`[exp3] Simulating transferTokenPreApproved...`);
  await publicClient.simulateContract({
    address: contractAddress,
    abi: TRANSFERS_ABI,
    functionName: "transferTokenPreApproved",
    args: [intent],
    account: operatorAddress,
  });
  console.log(`[exp3] ✓ Simulation passed`);

  // Execute
  console.log(`[exp3] Broadcasting transferTokenPreApproved...`);
  const topupHash = await walletClient.writeContract({
    address: contractAddress,
    abi: TRANSFERS_ABI,
    functionName: "transferTokenPreApproved",
    args: [intent],
  });

  const topupReceipt = await publicClient.waitForTransactionReceipt({
    hash: topupHash,
  });
  console.log(
    `[exp3] ✓ Top-up tx confirmed. Gas: ${topupReceipt.gasUsed}, Status: ${topupReceipt.status}`
  );

  // ─── Step 4: Verify credits ──────────────────────────────────────
  console.log(`\n[exp3] Step 4: Polling for OpenRouter credits...`);
  let creditsAfter = creditsBefore;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    creditsAfter = await getCredits(env.openrouterApiKey);
    const delta = creditsAfter - creditsBefore;
    console.log(
      `[exp3] Poll ${i + 1}/30: credits=$${creditsAfter.toFixed(4)} (delta=$${delta.toFixed(4)})`
    );
    if (delta > 0) break;
  }

  // ─── Results ─────────────────────────────────────────────────────
  const totalTime = Date.now() - startTime;
  const creditDelta = creditsAfter - creditsBefore;

  console.log(`\n[exp3] ═══════════════════════════════════════════`);
  console.log(` FULL CHAIN RESULTS`);
  console.log(`═══════════════════════════════════════════════════`);
  console.log(`  Step 1 (send to split):    tx ${sendHash}`);
  console.log(`    Gas: ${sendReceipt.gasUsed}`);
  console.log(`  Step 2 (distribute):       tx ${distributeHash}`);
  console.log(`    Gas: ${distributeReceipt.gasUsed}`);
  console.log(`  Step 3 (approve Permit2):  tx ${approveHash}`);
  console.log(`  Step 3 (OpenRouter topup): tx ${topupHash}`);
  console.log(`    Gas: ${topupReceipt.gasUsed}`);
  console.log(`  Step 4 (credits check):`);
  console.log(`    Before:                  $${creditsBefore.toFixed(4)}`);
  console.log(`    After:                   $${creditsAfter.toFixed(4)}`);
  console.log(`    Delta:                   $${creditDelta.toFixed(4)}`);
  console.log(
    `  Total time:                ${totalTime}ms (${(totalTime / 1000).toFixed(1)}s)`
  );
  console.log(
    `  Total gas:                 ${sendReceipt.gasUsed + distributeReceipt.gasUsed + topupReceipt.gasUsed}`
  );
  console.log(
    `\n  Chain proven: ${creditDelta > 0 ? "✓ USDC → Split → Wallet → OpenRouter credits" : "⚠️  Credits not yet reflected"}`
  );
}

main().catch((err) => {
  console.error("\n[exp3] FATAL:", err);
  process.exit(1);
});
