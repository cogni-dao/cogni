// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/funding.server`
 * Purpose: Read-only snapshot of the AI-funding pipeline — the three balances that decide
 *   whether the node's AI is funded: OpenRouter runway, operator-wallet working capital,
 *   and steward-wallet balance. Each read is resilient (null on failure) so the panel
 *   degrades gracefully when a credential/RPC is missing in an environment.
 * Scope: Server-only. HTTPS read to OpenRouter + on-chain USDC balanceOf via EVM_RPC_URL.
 *   Does not move funds or write anything.
 * Invariants: NEVER throws — every read is try/caught to null; the panel must always render.
 * Side-effects: IO (OpenRouter HTTPS GET, Base RPC reads).
 * Links: src/app/(admin)/admin/payments/AiFundingPanel.client.tsx, docs/design/node-steward-wallet.md
 * @public
 */

import "server-only";

import { createPublicClient, erc20Abi, getAddress, http } from "viem";
import {
  getOperatorWalletConfig,
  getStewardWalletConfig,
} from "@/shared/config";
import { serverEnv } from "@/shared/env";
import { USDC_TOKEN_ADDRESS } from "@/shared/web3";

const USDC_DECIMALS = 6;

export interface AiFunding {
  /** OpenRouter remaining credits (USD) = total_credits − total_usage. */
  openRouterRemainingUsd: number | null;
  /** Operator (Privy) wallet USDC — DAO working capital (95% of user payments). */
  operatorWalletUsdc: number | null;
  /** Steward wallet USDC — human-custodied, pays vendors. */
  stewardWalletUsdc: number | null;
  operatorWalletAddress: string | null;
  stewardWalletAddress: string | null;
}

async function fetchOpenRouterRemaining(
  apiKey: string
): Promise<number | null> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { total_credits?: number; total_usage?: number };
    };
    const credits = body.data?.total_credits;
    const usage = body.data?.total_usage;
    if (typeof credits !== "number" || typeof usage !== "number") return null;
    return credits - usage;
  } catch {
    return null;
  }
}

async function usdcBalance(
  address: string,
  rpcUrl: string
): Promise<number | null> {
  try {
    const client = createPublicClient({ transport: http(rpcUrl) });
    const raw = (await client.readContract({
      address: getAddress(USDC_TOKEN_ADDRESS),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(address)],
    })) as bigint;
    return Number(raw) / 10 ** USDC_DECIMALS;
  } catch {
    return null;
  }
}

export async function getAiFunding(): Promise<AiFunding> {
  const env = serverEnv();
  const operator = getOperatorWalletConfig()?.address ?? null;
  const steward = getStewardWalletConfig()?.address ?? null;
  const rpc = env.EVM_RPC_URL;

  const [openRouterRemainingUsd, operatorWalletUsdc, stewardWalletUsdc] =
    await Promise.all([
      env.OPENROUTER_API_KEY
        ? fetchOpenRouterRemaining(env.OPENROUTER_API_KEY)
        : Promise.resolve(null),
      rpc && operator ? usdcBalance(operator, rpc) : Promise.resolve(null),
      rpc && steward ? usdcBalance(steward, rpc) : Promise.resolve(null),
    ]);

  return {
    openRouterRemainingUsd,
    operatorWalletUsdc,
    stewardWalletUsdc,
    operatorWalletAddress: operator,
    stewardWalletAddress: steward,
  };
}
