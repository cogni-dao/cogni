// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/sign-polymarket-order`
 * Purpose: task.0315 Phase 1 CP2 evidence — prove the Privy operator wallet can sign a
 *   Polymarket CLOB EIP-712 order on Polygon via the CP3 seam (Privy viem account +
 *   @polymarket/clob-client `ExchangeOrderBuilder`). No shim, no hand-rolled envelope.
 * Scope: Constructs an offline placeholder CLOB order, signs via Privy HSM, verifies the signer against the operator's EOA via `viem.verifyTypedData`. Does not place, submit, or broadcast any order; does not move USDC; does not touch on-chain state.
 * Invariants: Polygon chainId 137 only; no raw key material; uses operator wallet's existing
 *   PRIVY_* credentials. Not for production use.
 * Side-effects: IO (reads .env.local; lists Privy wallets via HTTPS; submits one HSM sign
 *   request).
 * Links: https://poly.cognidao.org/knowledge/poly-copy-trade-pipeline
 * @internal — experiment code, not shipped to production
 */

import path from "node:path";
import {
  ExchangeOrderBuilder,
  OrderSide,
  SignatureType,
} from "@polymarket/clob-client";
import { PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import { config } from "dotenv";
import { createWalletClient, type Hex, http, verifyTypedData } from "viem";
import { polygon } from "viem/chains";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

config({ path: path.resolve(__dirname, "../../.env.local") });
config({ path: path.resolve(__dirname, ".env") });

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`[cp2] Missing required env var: ${key}`);
    console.error(
      `       Copy from main worktree .env.local: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_SIGNING_KEY, OPERATOR_WALLET_ADDRESS`
    );
    process.exit(1);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Constants — Polymarket CTF Exchange on Polygon
// ---------------------------------------------------------------------------

const POLYGON_CHAIN_ID = 137;
/** CTF Exchange contract — source: @polymarket/clob-client config.js POLYGON branch */
const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function main(): Promise<void> {
  const appId = requireEnv("PRIVY_APP_ID");
  const appSecret = requireEnv("PRIVY_APP_SECRET");
  const signingKey = requireEnv("PRIVY_SIGNING_KEY");
  const expectedAddress = requireEnv("OPERATOR_WALLET_ADDRESS") as Hex;

  console.log("[cp2] Resolving Privy wallet id for operator EOA...");
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
      `[cp2] FAIL: Privy has no wallet matching ${expectedAddress}. Run scripts/provision-operator-wallet.ts first.`
    );
    process.exit(1);
  }
  console.log(`[cp2] walletId: ${walletId}`);

  // --- Build the Privy-backed viem account ---
  // createViemAccount does camelCase→snake_case translation, authorization_context
  // passthrough, and .signature unwrap internally. We do zero manual translation.
  const account = createViemAccount(privy, {
    walletId,
    address: expectedAddress,
    authorizationContext: { authorization_private_keys: [signingKey] },
  });

  // WalletClient wraps the LocalAccount so @polymarket/clob-client accepts it as a
  // `ClobSigner`. Signing is local — no RPC call fires despite the http transport.
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  // --- Construct a placeholder CLOB order (offline) ---
  const builder = new ExchangeOrderBuilder(
    CTF_EXCHANGE_ADDRESS,
    POLYGON_CHAIN_ID,
    walletClient
  );

  // Placeholder amounts: 1 USDC at $0.50 = 2 outcome tokens. Contents are irrelevant
  // for proving the signature seam — correctness is crypto, not economics.
  const order = await builder.buildOrder({
    maker: expectedAddress,
    taker: ZERO_ADDRESS,
    tokenId:
      "71321045679252212594626385532706912750332728571942532289631379312455583992162",
    makerAmount: "1000000",
    takerAmount: "2000000",
    side: OrderSide.BUY,
    feeRateBps: "0",
    nonce: "0",
    signatureType: SignatureType.EOA,
  });

  const typedData = builder.buildOrderTypedData(order);
  console.log("[cp2] Built CLOB order typed-data:");
  console.log(`       primaryType   : ${typedData.primaryType}`);
  console.log(`       domain.chainId: ${typedData.domain.chainId}`);
  console.log(`       domain.contract: ${typedData.domain.verifyingContract}`);
  console.log(`       order.salt    : ${order.salt}`);

  // --- Sign via Privy HSM ---
  console.log("[cp2] Requesting HSM signature via Privy...");
  const signature = (await builder.buildOrderSignature(typedData)) as Hex;
  console.log(
    `[cp2] Signature (${signature.length - 2}/2 hex chars): ${signature}`
  );

  // --- Recover signer and verify ---
  // viem.verifyTypedData derives EIP712Domain; strip it from the types to avoid conflict.
  const { EIP712Domain: _unused, ...typesForViem } = typedData.types as Record<
    string,
    Array<{ name: string; type: string }>
  >;
  const ok = await verifyTypedData({
    address: expectedAddress,
    domain: typedData.domain as Parameters<typeof verifyTypedData>[0]["domain"],
    types: typesForViem,
    primaryType: typedData.primaryType,
    message: typedData.message as Record<string, unknown>,
    signature,
  });

  if (!ok) {
    console.error(
      `[cp2] FAIL: recovered signer does NOT match expected ${expectedAddress}`
    );
    process.exit(1);
  }

  console.log(
    `[cp2] PASS — Polymarket CLOB order signed by ${expectedAddress}`
  );
  console.log("[cp2] --- PR evidence ---");
  console.log(JSON.stringify({ expectedAddress, signature, order }, null, 2));
}

main().catch((err: unknown) => {
  console.error("[cp2] unhandled error:", err);
  process.exit(1);
});
