// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/onboard-raw-pk-wallet`
 * Purpose: One-shot onboarding of a raw-private-key EOA to Polymarket CLOB — approve 3 CLOB contracts for USDC.e, approve 2 CTF operators for ERC-1155 SELL, and derive L2 API creds. Raw-PK sibling of the Privy-based `approve-polymarket-allowances.ts` + `derive-polymarket-api-keys.ts`.
 * Scope: Signs with viem `privateKeyToAccount`; idempotent (skips MaxUint256 allowances and already-set CTF approvals). Prints a paste-ready env block. Does not place orders or move USDC.e.
 * Invariants: Polygon chainId 137; EOA path only.
 * Side-effects: IO (reads .env.test; Polygon RPC reads + up to 5 approve txs ~0.04 POL gas; one signed HTTPS request to Polymarket CLOB auth endpoint).
 * Links: https://poly.cognidao.org/knowledge/poly-wallet-trading-lessons (Privy variant)
 * @internal — experiment code, not shipped to production
 */

import path from "node:path";
import { ClobClient } from "@polymarket/clob-client";
import { config } from "dotenv";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  type Hex,
  http,
  maxUint256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

config({ path: path.resolve(__dirname, "../../.env.test") });
config({ path: path.resolve(__dirname, "../../.env.local") });

const USDC_E_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as Address;
const CTF_POLYGON = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as Address;
const SPENDERS: Array<{ name: string; address: Address }> = [
  { name: "Exchange", address: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" },
  {
    name: "Neg-Risk Exchange",
    address: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  },
  {
    name: "Neg-Risk Adapter",
    address: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
  },
];
// CTF (ERC-1155) operators — required for SELL (transferring outcome shares).
// Adapter does not take ERC-1155 custody, only the two exchange contracts.
const CTF_OPERATORS: Array<{ name: string; address: Address }> = [
  { name: "Exchange", address: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" },
  {
    name: "Neg-Risk Exchange",
    address: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  },
];

const ERC1155_APPROVAL_ABI = [
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

const DEFAULT_RPC = "https://polygon-bor-rpc.publicnode.com";
const POLYGON_CHAIN_ID = 137;
const CLOB_HOST = "https://clob.polymarket.com";

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[onboard] Missing env: ${key}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const pkRaw = requireEnv("TEST_WALLET_PRIVATE_KEY");
  const pk: Hex = pkRaw.startsWith("0x")
    ? (pkRaw as Hex)
    : (`0x${pkRaw}` as Hex);
  const account = privateKeyToAccount(pk);
  const rpcUrl = process.env.POLYGON_RPC_URL ?? DEFAULT_RPC;

  console.log(`[onboard] EOA:   ${account.address}`);
  console.log(`[onboard] RPC:   ${rpcUrl}`);
  console.log(`[onboard] Token: USDC.e (${USDC_E_POLYGON})`);

  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(rpcUrl),
  });

  for (const spender of SPENDERS) {
    console.log(`\n[onboard] --- ${spender.name} (${spender.address}) ---`);

    const current = await publicClient.readContract({
      address: USDC_E_POLYGON,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, spender.address],
    });
    console.log(`[onboard]   current allowance: ${current.toString()}`);
    if (current === maxUint256) {
      console.log("[onboard]   already max — skipping");
      continue;
    }

    console.log("[onboard]   submitting approve(spender, MaxUint256)...");
    const hash = await walletClient.writeContract({
      address: USDC_E_POLYGON,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender.address, maxUint256],
    });
    console.log(`[onboard]   tx: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });
    if (receipt.status !== "success") {
      console.error(`[onboard]   tx reverted: ${hash}`);
      process.exit(1);
    }
    const after = await publicClient.readContract({
      address: USDC_E_POLYGON,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, spender.address],
      blockNumber: receipt.blockNumber,
    });
    if (after !== maxUint256) {
      console.error(
        `[onboard]   FAIL: allowance is ${after.toString()}, expected max`
      );
      process.exit(1);
    }
    console.log("[onboard]   allowance now max ✓");
  }

  for (const op of CTF_OPERATORS) {
    console.log(`\n[onboard] --- CTF operator ${op.name} (${op.address}) ---`);
    const approved = await publicClient.readContract({
      address: CTF_POLYGON,
      abi: ERC1155_APPROVAL_ABI,
      functionName: "isApprovedForAll",
      args: [account.address, op.address],
    });
    console.log(`[onboard]   current isApprovedForAll: ${approved}`);
    if (approved) {
      console.log("[onboard]   already approved — skipping");
      continue;
    }
    console.log("[onboard]   submitting setApprovalForAll(operator, true)...");
    const hash = await walletClient.writeContract({
      address: CTF_POLYGON,
      abi: ERC1155_APPROVAL_ABI,
      functionName: "setApprovalForAll",
      args: [op.address, true],
    });
    console.log(`[onboard]   tx: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });
    if (receipt.status !== "success") {
      console.error(`[onboard]   tx reverted: ${hash}`);
      process.exit(1);
    }
    console.log("[onboard]   CTF approval set ✓");
  }

  console.log("\n[onboard] Deriving L2 CLOB API creds...");
  const clob = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, walletClient);
  const creds = await clob.createOrDeriveApiKey();

  console.log("\n[onboard] PASS — paste into .env.test:\n");
  console.log(`TEST_WALLET_POLY_CLOB_API_KEY=${creds.key}`);
  console.log(`TEST_WALLET_POLY_CLOB_API_SECRET=${creds.secret}`);
  console.log(`TEST_WALLET_POLY_CLOB_PASSPHRASE=${creds.passphrase}`);
  console.log(
    "\n[onboard] Idempotent — re-running returns the same creds for this EOA."
  );
}

main().catch((err: unknown) => {
  console.error("[onboard] unhandled error:", err);
  process.exit(1);
});
