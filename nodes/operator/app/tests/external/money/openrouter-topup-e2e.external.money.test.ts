// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/external/money/openrouter-topup-e2e.external.money`
 * Purpose: End-to-end money test — creates a payment intent, sends real USDC on Base,
 *   submits the tx hash, polls until CONFIRMED, then asserts the OpenRouter credit delta.
 *   Deep accounting assertions (Postgres provider_funding_attempts + TigerBeetle deltas)
 *   run ONLY when DATABASE_SERVICE_URL + TIGERBEETLE_ADDRESS are reachable (local dev:stack).
 * Scope: Black-box test against any running build via TEST_BASE_URL. Portable to a deployment:
 *   the HTTP path (intent → submit → poll CONFIRMED) + OpenRouter credit delta always run;
 *   the direct-DB/TB assertions are skipped when those endpoints aren't reachable.
 * Invariants: Spends ~$2.00 USDC per run (MIN_PAYMENT_CENTS). Requires a funded test wallet.
 *   To run against a deployment: set TEST_BASE_URL=https://<node-url> + OPENROUTER_API_KEY +
 *   TEST_WALLET_PRIVATE_KEY + EVM_RPC_URL, and OMIT DATABASE_SERVICE_URL/TIGERBEETLE_ADDRESS.
 * Side-effects: Real on-chain USDC transfer, real OpenRouter charge; real DB reads when DB present.
 * Links: docs/spec/web3-openrouter-payments.md, docs/spec/financial-ledger.md, docs/design/node-payments-activation.md
 * @internal
 */

import { randomUUID } from "node:crypto";
import { createServiceDbClient } from "@cogni/db-client/service";
import { users } from "@cogni/db-schema";
import { providerFundingAttempts } from "@cogni/db-schema/billing";
import { ACCOUNT } from "@cogni/financial-ledger";
import { createTigerBeetleAdapter } from "@cogni/financial-ledger/adapters";
import { MIN_PAYMENT_CENTS } from "@cogni/node-core";
import { CHAIN_ID } from "@cogni/node-shared";
import {
  type NextAuthSessionCookie,
  siweLogin,
} from "@tests/_fixtures/auth/nextauth-http-helpers";
import { eq } from "drizzle-orm";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { beforeAll, describe, expect, it } from "vitest";

// ── ABI ──────────────────────────────────────────────────────────────

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

// ── Env ──────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for money tests`);
  return value;
}

const TEST_BASE_URL = (
  process.env.TEST_BASE_URL ?? "http://localhost:3000"
).replace(/\/$/, "");
// Deep accounting assertions (Postgres + TigerBeetle) are local-stack only.
// Against a deployment these endpoints aren't reachable from the runner — omit them
// and the test still proves the loop via poll→CONFIRMED + OpenRouter credit delta.
const DATABASE_SERVICE_URL = process.env.DATABASE_SERVICE_URL;
const TIGERBEETLE_ADDRESS = process.env.TIGERBEETLE_ADDRESS;
const OPENROUTER_API_KEY = requireEnv("OPENROUTER_API_KEY");
const rawKey = requireEnv("TEST_WALLET_PRIVATE_KEY");
const TEST_WALLET_PRIVATE_KEY = (
  rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`
) as `0x${string}`;

// ── API Response Types ───────────────────────────────────────────────

interface IntentResponse {
  attemptId: string;
  chainId: number;
  token: string;
  to: string;
  amountRaw: string;
  amountUsdCents: number;
  expiresAt: string;
}

interface SubmitResponse {
  attemptId: string;
  status: string;
  txHash: string;
  errorCode?: string;
  errorMessage?: string;
}

interface StatusResponse {
  attemptId: string;
  status: "PENDING_VERIFICATION" | "CONFIRMED" | "FAILED";
  txHash: string | null;
  amountUsdCents: number;
  errorCode?: string;
  createdAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

async function getOpenRouterCredits(apiKey: string): Promise<number> {
  const res = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok)
    throw new Error(`OpenRouter credits fetch failed: ${res.status}`);
  const data = (await res.json()) as {
    data: { total_credits: number; total_usage: number };
  };
  return data.data.total_credits;
}

/** Poll status endpoint until terminal state or timeout. */
async function pollUntilTerminal(
  baseUrl: string,
  attemptId: string,
  cookieStr: string,
  maxWaitMs = 45_000,
  intervalMs = 3_000
): Promise<StatusResponse> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(
      `${baseUrl}/api/v1/payments/attempts/${attemptId}`,
      { headers: { Cookie: cookieStr } }
    );
    if (!res.ok) throw new Error(`Status poll failed: ${res.status}`);
    const data = (await res.json()) as StatusResponse;

    if (data.status === "CONFIRMED" || data.status === "FAILED") {
      return data;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Payment did not reach terminal state within ${maxWaitMs}ms`);
}

// ── Test ─────────────────────────────────────────────────────────────

describe("OpenRouter top-up e2e (live money)", () => {
  // Deep PG/TigerBeetle assertions are valid ONLY when the target IS the local
  // stack — a remote deployment's DB/TB are not the ones reachable here. Against
  // any non-local TEST_BASE_URL, force deployment-portable mode regardless of the
  // auto-loaded .env.local values (which point at localhost).
  const isLocalTarget =
    TEST_BASE_URL.includes("localhost") || TEST_BASE_URL.includes("127.0.0.1");
  const db =
    isLocalTarget && DATABASE_SERVICE_URL
      ? createServiceDbClient(DATABASE_SERVICE_URL)
      : null;
  const deep = Boolean(db && TIGERBEETLE_ADDRESS);
  const testWallet = privateKeyToAccount(TEST_WALLET_PRIVATE_KEY);
  let testUserId: string = randomUUID();
  let sessionCookie: NextAuthSessionCookie | null = null;

  function cookie(): string {
    if (!sessionCookie) throw new Error("SIWE login did not complete");
    return `${sessionCookie.name}=${sessionCookie.value}`;
  }

  const publicClient = createPublicClient({
    chain: base,
    transport: http(process.env.EVM_RPC_URL),
  });
  const walletClient = createWalletClient({
    account: testWallet,
    chain: base,
    transport: http(process.env.EVM_RPC_URL),
  });

  // ── Setup ────────────────────────────────────────────────────────

  beforeAll(async () => {
    if (!deep) {
      console.log(
        "[money] deep accounting assertions DISABLED (no DATABASE_SERVICE_URL/TIGERBEETLE_ADDRESS) — running deployment-portable HTTP + OpenRouter checks only"
      );
    }

    // Local stack: ensure the wallet's user exists. Against a deployment, SIWE
    // login mints the user on first contact, so this pre-insert is skipped.
    if (db) {
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.walletAddress, testWallet.address))
        .limit(1);

      if (existing[0]) {
        testUserId = existing[0].id;
      } else {
        await db.insert(users).values({
          id: testUserId,
          walletAddress: testWallet.address,
          name: "Money Test User",
        });
      }
    }

    const domain = new URL(TEST_BASE_URL).host;
    const loginResult = await siweLogin({
      baseUrl: TEST_BASE_URL,
      wallet: { account: testWallet, privateKey: TEST_WALLET_PRIVATE_KEY },
      domain,
      chainId: CHAIN_ID,
    });

    if (!loginResult.success || !loginResult.sessionCookie) {
      throw new Error(
        `SIWE login failed: ${loginResult.error ?? "no session cookie returned"}`
      );
    }
    sessionCookie = loginResult.sessionCookie;
  }, 30_000);

  // No cleanup — the test wallet user persists in the dev DB.
  // SIWE login creates identity_events rows that prevent FK-cascaded deletion.

  // ── The test ─────────────────────────────────────────────────────

  it("intent → USDC transfer → submit → poll CONFIRMED → OpenRouter credit delta (+ TB/Postgres when local)", async () => {
    // 1. Snapshot TigerBeetle balances BEFORE (deep, local only)
    const tb =
      deep && TIGERBEETLE_ADDRESS
        ? createTigerBeetleAdapter(TIGERBEETLE_ADDRESS)
        : null;
    const tbBefore = tb
      ? await (async () => {
          const [treasury, operator, provider] = await Promise.all([
            tb.getAccountBalance(ACCOUNT.ASSETS_TREASURY),
            tb.getAccountBalance(ACCOUNT.ASSETS_OPERATOR_FLOAT),
            tb.getAccountBalance(ACCOUNT.ASSETS_PROVIDER_FLOAT),
          ]);
          return { treasury, operator, provider };
        })()
      : null;

    // 2. Record OpenRouter credits BEFORE (always — the portable proof)
    const creditsBefore = await getOpenRouterCredits(OPENROUTER_API_KEY);
    console.log(`OpenRouter credits before: ${creditsBefore}`);

    // 2. Create payment intent
    const intentRes = await fetch(`${TEST_BASE_URL}/api/v1/payments/intents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie(),
      },
      body: JSON.stringify({ amountUsdCents: MIN_PAYMENT_CENTS }),
    });
    expect(intentRes.ok).toBe(true);
    const intent = (await intentRes.json()) as IntentResponse;
    console.log(
      `Intent created: id=${intent.attemptId}, to=${intent.to}, amountRaw=${intent.amountRaw}`
    );

    // 3. Send USDC on-chain to the intent's receiving address
    const transferHash = await walletClient.writeContract({
      address: intent.token as Address,
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [intent.to as Address, BigInt(intent.amountRaw)],
    });
    console.log(`USDC transfer tx: ${transferHash}`);

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transferHash,
    });
    expect(receipt.status).toBe("success");

    // 4. Submit tx hash to the app
    const submitRes = await fetch(
      `${TEST_BASE_URL}/api/v1/payments/attempts/${intent.attemptId}/submit`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie(),
        },
        body: JSON.stringify({ txHash: transferHash }),
      }
    );
    expect(submitRes.ok).toBe(true);
    const submitData = (await submitRes.json()) as SubmitResponse;
    console.log(`Submit response: status=${submitData.status}`);

    // 5. Poll until CONFIRMED (includes on-chain verification + post-credit funding)
    const finalStatus = await pollUntilTerminal(
      TEST_BASE_URL,
      intent.attemptId,
      cookie()
    );
    console.log(`Final status: ${finalStatus.status}`);
    expect(finalStatus.status).toBe("CONFIRMED");

    // 6. Wait for post-credit funding to complete (runs inline but involves on-chain txs)
    await new Promise((r) => setTimeout(r, 15_000));

    // 7. Deep accounting (local only): Postgres provider_funding_attempts + TigerBeetle deltas
    if (deep && db && tb && tbBefore) {
      // The funding key is ${chainId}:${txHash}
      const fundingKey = `${intent.chainId}:${transferHash}`;
      const fundingRows = await db
        .select()
        .from(providerFundingAttempts)
        .where(eq(providerFundingAttempts.paymentIntentId, fundingKey));

      expect(fundingRows).toHaveLength(1);
      const fundingRow = fundingRows[0];
      console.log(
        `Funding row: status=${fundingRow?.status}, chargeId=${fundingRow?.chargeId}, txHash=${fundingRow?.fundingTxHash}`
      );
      expect(fundingRow?.status).toBe("funded");
      expect(fundingRow?.fundingTxHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

      //    Expected micro-USDC amounts:
      //      SPLIT_DISTRIBUTE: cents × 10_000 = 200 × 10_000 = 2_000_000
      //      PROVIDER_TOPUP:   Math.round(topUpUsd × 100) × 10_000
      const expectedSplitDistribute = BigInt(MIN_PAYMENT_CENTS) * 10_000n;
      const topUpUsd =
        ((MIN_PAYMENT_CENTS / 100) * (1 + 0.75)) / (2.0 * (1 - 0.05));
      const expectedProviderTopup =
        BigInt(Math.round(topUpUsd * 100)) * 10_000n;

      const [treasuryAfter, operatorAfter, providerAfter] = await Promise.all([
        tb.getAccountBalance(ACCOUNT.ASSETS_TREASURY),
        tb.getAccountBalance(ACCOUNT.ASSETS_OPERATOR_FLOAT),
        tb.getAccountBalance(ACCOUNT.ASSETS_PROVIDER_FLOAT),
      ]);

      const treasuryDebitDelta =
        treasuryAfter.debitsPosted - tbBefore.treasury.debitsPosted;
      const operatorCreditDelta =
        operatorAfter.creditsPosted - tbBefore.operator.creditsPosted;
      const operatorDebitDelta =
        operatorAfter.debitsPosted - tbBefore.operator.debitsPosted;
      const providerCreditDelta =
        providerAfter.creditsPosted - tbBefore.provider.creditsPosted;

      console.log(
        `TB deltas: treasury debit=${treasuryDebitDelta}, operator credit=${operatorCreditDelta} debit=${operatorDebitDelta}, provider credit=${providerCreditDelta}`
      );

      // Treasury debited exactly by SPLIT_DISTRIBUTE
      expect(treasuryDebitDelta).toBe(expectedSplitDistribute);
      // OperatorFloat credited by SPLIT_DISTRIBUTE, debited by PROVIDER_TOPUP
      expect(operatorCreditDelta).toBe(expectedSplitDistribute);
      expect(operatorDebitDelta).toBe(expectedProviderTopup);
      // ProviderFloat credited by PROVIDER_TOPUP
      expect(providerCreditDelta).toBe(expectedProviderTopup);
    }

    // 8. Assert OpenRouter: credit balance increased (always — portable proof)
    const creditsAfter = await getOpenRouterCredits(OPENROUTER_API_KEY);
    console.log(
      `OpenRouter credits after: ${creditsAfter} (delta: ${creditsAfter - creditsBefore})`
    );
    expect(creditsAfter).toBeGreaterThan(creditsBefore);
  }, 120_000);
});
