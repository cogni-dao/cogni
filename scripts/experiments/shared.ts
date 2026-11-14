// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/shared`
 * Purpose: Shared setup for operator wallet payment chain experiments (spike.0090).
 * Scope: Viem client setup, env loading, contract constants, Coinbase Transfers ABI. Does not make RPC calls or broadcast transactions.
 * Invariants: Base mainnet only (chain 8453); no production key material.
 * Side-effects: IO (reads .env file), process.env
 * Links: src/shared/web3/chain.ts
 * @internal — spike code, not for production use
 */

import path from "node:path";

import { config } from "dotenv";
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  type Hex,
  http,
  type PublicClient,
  parseUnits,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// Reuse canonical chain constants
import { CHAIN_ID, USDC_TOKEN_ADDRESS } from "@/shared/web3/chain";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

// Load from .env.local (project root), fall back to local .env
config({ path: path.resolve(__dirname, "../../.env.local") });
config({ path: path.resolve(__dirname, ".env") });

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`[spike] Missing required env var: ${key}`);
    console.error(`       Copy .env.example → .env and fill in values.`);
    process.exit(1);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export function getEnv() {
  // Normalize private key: viem requires 0x prefix
  const rawKey = requireEnv("OPERATOR_PRIVATE_KEY");
  const operatorPrivateKey = (
    rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`
  ) as Hex;

  return {
    openrouterApiKey: requireEnv("OPENROUTER_API_KEY"),
    operatorPrivateKey,
    // Treasury: explicit env var, or DAO wallet from repo-spec
    treasuryAddress: (process.env.TREASURY_ADDRESS ||
      "0xF61c3fafD4D34b4568e7a500d92b28Ac175e83C6") as Address,
    baseRpcUrl:
      process.env.EVM_RPC_URL ||
      process.env.BASE_RPC_URL ||
      "https://mainnet.base.org",
  };
}

export function createClients(env: ReturnType<typeof getEnv>) {
  const account = privateKeyToAccount(env.operatorPrivateKey);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(env.baseRpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(env.baseRpcUrl),
  });

  console.log(`[spike] Operator address: ${account.address}`);
  console.log(`[spike] Chain: Base mainnet (${CHAIN_ID})`);

  return { account, publicClient, walletClient };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** USDC on Base (6 decimals) — from canonical chain config */
export const USDC_ADDRESS = USDC_TOKEN_ADDRESS as Address;
export const USDC_DECIMALS = 6;

/**
 * Coinbase Commerce Onchain Payment Protocol — Transfers contract on Base.
 * Source: https://github.com/coinbase/commerce-onchain-payment-protocol
 *
 * TODO(task.0084): Extract to packages/vendor-contracts when building the real adapter.
 */
export const TRANSFERS_CONTRACT =
  "0xeADE6bE02d043b3550bE19E960504dbA14A14971" as Address;

/**
 * Coinbase Transfers contract ABI — only the functions we need.
 * Source: https://github.com/coinbase/commerce-onchain-payment-protocol/blob/master/contracts/transfers/Transfers.sol
 *
 * TODO(task.0084): Extract to packages/vendor-contracts when building the real adapter.
 */
export const TRANSFERS_ABI = [
  {
    type: "function",
    name: "swapAndTransferUniswapV3Native",
    inputs: [
      {
        name: "_intent",
        type: "tuple",
        components: [
          { name: "recipientAmount", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "recipientCurrency", type: "address" },
          { name: "refundDestination", type: "address" },
          { name: "feeAmount", type: "uint256" },
          { name: "id", type: "bytes16" },
          { name: "operator", type: "address" },
          { name: "signature", type: "bytes" },
          { name: "prefix", type: "bytes" },
        ],
      },
      { name: "poolFeesTier", type: "uint24" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "transferTokenPreApproved",
    inputs: [
      {
        name: "_intent",
        type: "tuple",
        components: [
          { name: "recipientAmount", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "recipientCurrency", type: "address" },
          { name: "refundDestination", type: "address" },
          { name: "feeAmount", type: "uint256" },
          { name: "id", type: "bytes16" },
          { name: "operator", type: "address" },
          { name: "signature", type: "bytes" },
          { name: "prefix", type: "bytes" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ---------------------------------------------------------------------------
// ERC-20 helpers
// ---------------------------------------------------------------------------

export const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export async function getUsdcBalance(
  publicClient: PublicClient,
  address: Address
): Promise<bigint> {
  return publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  });
}

export function formatUsdc(amount: bigint): string {
  return `${formatUnits(amount, USDC_DECIMALS)} USDC`;
}

export function parseUsdc(amount: string | number): bigint {
  return parseUnits(String(amount), USDC_DECIMALS);
}

export async function logBalances(
  publicClient: PublicClient,
  address: Address,
  label: string
): Promise<void> {
  const [ethBalance, usdcBalance] = await Promise.all([
    publicClient.getBalance({ address }),
    getUsdcBalance(publicClient, address),
  ]);
  console.log(
    `[spike] ${label}: ${formatEther(ethBalance)} ETH, ${formatUsdc(usdcBalance)}`
  );
}

// Re-export types for convenience
export type { Account, Address, Chain, Hex, PublicClient, WalletClient };
