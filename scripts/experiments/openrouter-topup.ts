// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/openrouter-topup`
 * Purpose: Experiment 1 — Validate OpenRouter crypto top-up on Base mainnet.
 * Scope: Creates a charge via OpenRouter API, executes the Coinbase Commerce transfer, verifies credits. Does not modify production state.
 * Invariants: Base mainnet only; test wallet with small amounts only.
 * Side-effects: IO (network: OpenRouter API + Base RPC), process.env
 * Links: spike.0090
 * @internal — spike code, not for production use
 */

import type { Address, Hex } from "viem";

import {
  createClients,
  ERC20_ABI,
  getEnv,
  logBalances,
  TRANSFERS_ABI,
  TRANSFERS_CONTRACT,
  USDC_ADDRESS,
} from "./shared";

// ---------------------------------------------------------------------------
// OpenRouter API
// ---------------------------------------------------------------------------

interface TransferIntentCallData {
  recipient_amount: string;
  deadline: string;
  recipient: string;
  recipient_currency: string;
  refund_destination: string;
  fee_amount: string;
  id: string; // bytes16 hex
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
  console.log(
    `\n[exp1] Creating OpenRouter charge: $${amount} from ${sender} on chain 8453`
  );

  const res = await fetch("https://openrouter.ai/api/v1/credits/coinbase", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount,
      sender,
      chain_id: 8453,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `OpenRouter charge creation failed (${res.status}): ${text}`
    );
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

const TOP_UP_AMOUNT_USD = 0.1; // $0.10
const DRY_RUN = process.argv.includes("--dry-run"); // Query charge only, don't execute

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log(" Experiment 1: OpenRouter Crypto Top-Up (Base)");
  console.log("═══════════════════════════════════════════════════\n");

  const env = getEnv();
  const { account, publicClient, walletClient } = createClients(env);

  // Pre-flight: check balances
  await logBalances(publicClient, account.address, "Pre-flight balances");

  // Step 1: Get current credits
  const creditsBefore = await getCredits(env.openrouterApiKey);
  console.log(`[exp1] Credits before: $${creditsBefore.toFixed(4)}`);

  // Step 2: Create charge
  const charge = await createCharge(
    env.openrouterApiKey,
    account.address,
    TOP_UP_AMOUNT_USD
  );

  const { transfer_intent } = charge.data.web3_data;
  const { metadata, call_data } = transfer_intent;

  console.log("\n[exp1] ═══ CHARGE RESPONSE (key findings) ═══");
  console.log(`  charge_id:          ${charge.data.id}`);
  console.log(`  expires_at:         ${charge.data.expires_at}`);
  console.log(`  contract_address:   ${metadata.contract_address}`);
  console.log(`  sender:             ${metadata.sender}`);
  console.log(`  chain_id:           ${metadata.chain_id}`);
  console.log(`  recipient:          ${call_data.recipient}`);
  console.log(`  recipient_currency: ${call_data.recipient_currency}`);
  console.log(`  recipient_amount:   ${call_data.recipient_amount}`);
  console.log(`  fee_amount:         ${call_data.fee_amount}`);
  console.log(`  deadline:           ${call_data.deadline}`);
  console.log(`  id (bytes16):       ${call_data.id}`);
  console.log(`  operator:           ${call_data.operator}`);

  // Log full response for posterity
  console.log("\n[exp1] Full transfer_intent JSON:");
  console.log(JSON.stringify(transfer_intent, null, 2));

  // Step 3: Validate contract address
  if (
    metadata.contract_address.toLowerCase() !== TRANSFERS_CONTRACT.toLowerCase()
  ) {
    console.warn(
      `\n[exp1] ⚠️  CONTRACT ADDRESS MISMATCH!` +
        `\n  Expected: ${TRANSFERS_CONTRACT}` +
        `\n  Got:      ${metadata.contract_address}` +
        `\n  Proceeding with returned address...`
    );
  } else {
    console.log(
      `\n[exp1] ✓ Contract address matches expected Transfers contract`
    );
  }

  const contractAddress = metadata.contract_address as Address;

  // Dry-run: stop after logging charge response (no gas spent)
  if (DRY_RUN) {
    console.log(`\n[exp1] ═══ DRY RUN — stopping before execution ═══`);
    console.log(
      `[exp1] Key findings logged above. Re-run without --dry-run to execute.`
    );
    process.exit(0);
  }

  // Step 4: Build the intent struct for the contract call
  // deadline may be ISO string or unix timestamp
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

  // Step 5: Use transferTokenPreApproved (USDC input)
  // The dry-run confirmed recipient_currency = Base USDC and no function_name in response.
  // Since both input and output are USDC, no swap needed — transferTokenPreApproved is correct.
  // Requires ERC-20 approval to the contract first.

  const totalUsdc = intent.recipientAmount + intent.feeAmount;

  console.log(`\n[exp1] Using transferTokenPreApproved (USDC input)`);
  console.log(
    `  recipientAmount: ${intent.recipientAmount} (${Number(intent.recipientAmount) / 1e6} USDC)`
  );
  console.log(
    `  feeAmount:       ${intent.feeAmount} (${Number(intent.feeAmount) / 1e6} USDC)`
  );
  console.log(
    `  total USDC:      ${totalUsdc} (${Number(totalUsdc) / 1e6} USDC)`
  );

  // Step 5a: Approve USDC to the Transfers contract directly.
  // transferTokenPreApproved uses direct ERC-20 transferFrom (NOT Permit2).
  // Source: Transfers.sol checks erc20.allowance(msg.sender, address(this))
  console.log(
    `\n[exp1] Approving ${Number(totalUsdc) / 1e6} USDC to Transfers contract (${contractAddress})...`
  );
  const approveHash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [contractAddress, totalUsdc],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`[exp1] ✓ Approval confirmed`);

  // Step 6: Simulate
  console.log(`\n[exp1] Simulating transferTokenPreApproved...`);
  try {
    await publicClient.simulateContract({
      address: contractAddress,
      abi: TRANSFERS_ABI,
      functionName: "transferTokenPreApproved",
      args: [intent],
      account: account.address,
    });
    console.log(`[exp1] ✓ Simulation passed`);
  } catch (err) {
    console.error(`[exp1] ✗ Simulation FAILED:`, err);
    process.exit(1);
  }

  // Step 7: Execute
  console.log(`\n[exp1] Broadcasting transferTokenPreApproved...`);
  const startTime = Date.now();

  const txHash = await walletClient.writeContract({
    address: contractAddress,
    abi: TRANSFERS_ABI,
    functionName: "transferTokenPreApproved",
    args: [intent],
  });

  console.log(`[exp1] ✓ Tx broadcast: ${txHash}`);

  // Step 8: Wait for confirmation
  console.log(`[exp1] Waiting for confirmation...`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });

  const confirmTime = Date.now() - startTime;
  console.log(`\n[exp1] ═══ TRANSACTION RESULT ═══`);
  console.log(`  tx_hash:     ${receipt.transactionHash}`);
  console.log(`  block:       ${receipt.blockNumber}`);
  console.log(`  status:      ${receipt.status}`);
  console.log(`  gas_used:    ${receipt.gasUsed}`);
  console.log(`  confirm_ms:  ${confirmTime}ms`);

  // Step 9: Check balances after
  await logBalances(publicClient, account.address, "Post-tx balances");

  // Step 10: Poll for credits
  console.log(`\n[exp1] Polling for OpenRouter credits...`);
  let creditsAfter = creditsBefore;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    creditsAfter = await getCredits(env.openrouterApiKey);
    const delta = creditsAfter - creditsBefore;
    console.log(
      `[exp1] Poll ${i + 1}/30: credits=$${creditsAfter.toFixed(4)} (delta=$${delta.toFixed(4)})`
    );
    if (delta > 0) break;
  }

  const creditDelta = creditsAfter - creditsBefore;
  console.log(`\n[exp1] ═══ FINAL RESULTS ═══`);
  console.log(`  Credits before:  $${creditsBefore.toFixed(4)}`);
  console.log(`  Credits after:   $${creditsAfter.toFixed(4)}`);
  console.log(`  Delta:           $${creditDelta.toFixed(4)}`);
  console.log(
    `  Expected (after 5% fee): $${(TOP_UP_AMOUNT_USD * 0.95).toFixed(4)}`
  );
  console.log(
    `  Status: ${creditDelta > 0 ? "✓ SUCCESS" : "⚠️  Credits not yet reflected (may need more time)"}`
  );

  console.log(`\n[exp1] ═══ SPIKE FINDINGS ═══`);
  console.log(`  Function used:     transferTokenPreApproved (USDC input)`);
  console.log(`  Contract address:  ${contractAddress}`);
  console.log(
    `  Matches old expected:  ${contractAddress.toLowerCase() === TRANSFERS_CONTRACT.toLowerCase()} (new contract!)`
  );
  console.log(`  USDC total:        ${Number(totalUsdc) / 1e6} USDC`);
  console.log(`  Confirm time:      ${confirmTime}ms`);
  console.log(`  Gas used:          ${receipt.gasUsed}`);
}

main().catch((err) => {
  console.error("\n[exp1] FATAL:", err);
  process.exit(1);
});
