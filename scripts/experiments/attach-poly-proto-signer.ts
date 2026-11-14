// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/attach-poly-proto-signer`
 * Purpose: task.0315 Phase 1 — register POLY_PROTO_PRIVY_SIGNING_KEY as an authorized signer for the prototype wallet via Privy's key-quorum API.
 * Scope: Derives the P-256 public key from POLY_PROTO_PRIVY_SIGNING_KEY locally (no Privy call), POSTs /v1/key_quorums, then PATCHes the wallet to add the new quorum as an additional_signer. Does not move funds.
 * Invariants: Quorum creation is the real product; wallet update may 401 for dashboard-owned wallets and is treated as non-fatal.
 * Side-effects: IO (reads .env.local; one POST /v1/key_quorums; up to two PATCH /v1/wallets/{id}).
 * Links: https://poly.cognidao.org/knowledge/poly-wallet-trading-lessons
 * @internal — experiment code, not shipped to production
 */

import crypto from "node:crypto";
import path from "node:path";
import { PrivyClient } from "@privy-io/node";
import { config } from "dotenv";

config({ path: path.resolve(__dirname, "../../.env.local") });

function require_(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[attach] missing env: ${key}`);
    process.exit(1);
  }
  return v;
}

/**
 * Privy stores authorization keys as `wallet-auth:<base64 PKCS8 DER P-256>`.
 * Derive the public key in base64-encoded SPKI DER format (Privy's
 * `public_keys` field accepts that shape).
 */
function publicKeyB64Der(walletAuthKey: string): string {
  const stripped = walletAuthKey.replace(/^wallet-auth:/, "");
  const der = Buffer.from(stripped, "base64");
  const priv = crypto.createPrivateKey({
    key: der,
    format: "der",
    type: "pkcs8",
  });
  const pub = crypto.createPublicKey(priv);
  const spkiDer = pub.export({ format: "der", type: "spki" });
  return Buffer.from(spkiDer).toString("base64");
}

async function main(): Promise<void> {
  const appId = require_("PRIVY_APP_ID");
  const appSecret = require_("PRIVY_APP_SECRET");
  const protoSigningKey = require_("POLY_PROTO_PRIVY_SIGNING_KEY");
  const protoWalletAddr = require_("POLY_PROTO_WALLET_ADDRESS").toLowerCase();

  console.log(
    "[attach] deriving public key from POLY_PROTO_PRIVY_SIGNING_KEY..."
  );
  const pubKey = publicKeyB64Der(protoSigningKey);
  console.log(`[attach]   pubkey (b64): ${pubKey.slice(0, 40)}...`);

  const privy = new PrivyClient({ appId, appSecret });

  // Resolve walletId
  let walletId: string | undefined;
  for await (const w of privy.wallets().list()) {
    if (w.address.toLowerCase() === protoWalletAddr) {
      walletId = w.id;
      break;
    }
  }
  if (!walletId) {
    console.error(`[attach] FAIL: wallet ${protoWalletAddr} not found in app`);
    process.exit(1);
  }
  console.log(`[attach] wallet id: ${walletId}`);

  // Step 1: create key quorum containing our pubkey (no auth signature needed)
  console.log("[attach] creating key quorum...");
  const kqService = (
    privy as unknown as {
      keyQuorums: () => {
        create: (params: {
          public_keys: string[];
          authorization_threshold: number;
          display_name?: string;
        }) => Promise<{ id: string }>;
      };
    }
  ).keyQuorums();
  const quorum = await kqService.create({
    public_keys: [pubKey],
    authorization_threshold: 1,
    display_name: "poly-trading-prototype-signer",
  });
  console.log(`[attach]   quorum id: ${quorum.id}`);

  // Step 2: update wallet to add this quorum as additional_signer.
  // This requires an authorization signature from the wallet's CURRENT owner.
  // Try with the proto signing key first (Derek may have set it as quorum
  // owner during wallet creation), fall back to the prod signing key.
  console.log("[attach] attaching quorum as additional_signer on wallet...");
  const walletsSvc = (
    privy as unknown as {
      wallets: () => {
        update: (
          walletId: string,
          params: {
            additional_signers: Array<{ signer_id: string }>;
            authorization_context?: { authorization_private_keys: string[] };
          }
        ) => Promise<{ id: string; additional_signers: unknown }>;
      };
    }
  ).wallets();

  const candidates = [
    { name: "POLY_PROTO_PRIVY_SIGNING_KEY", key: protoSigningKey },
    {
      name: "PRIVY_SIGNING_KEY (prod)",
      key: process.env.PRIVY_SIGNING_KEY ?? "",
    },
  ];
  let updated: { additional_signers: unknown } | null = null;
  let lastErr: unknown;
  for (const cand of candidates) {
    if (!cand.key) continue;
    try {
      console.log(`[attach]   trying authorization with ${cand.name}...`);
      updated = await walletsSvc.update(walletId, {
        additional_signers: [{ signer_id: quorum.id }],
        authorization_context: { authorization_private_keys: [cand.key] },
      });
      console.log(`[attach]   ✓ accepted by ${cand.name}`);
      break;
    } catch (e) {
      lastErr = e;
      console.log(`[attach]   ✗ rejected by ${cand.name}`);
    }
  }
  if (!updated) {
    console.error(
      "[attach] FAIL — no available signing key authorized this wallet update."
    );
    console.error(
      "[attach] Quorum WAS created (id:",
      quorum.id,
      ") but not attached."
    );
    console.error(
      "[attach] Derek must attach quorum",
      quorum.id,
      "to wallet",
      walletId,
      "via dashboard:"
    );
    console.error(
      "[attach]   https://dashboard.privy.io → Wallets →",
      `${protoWalletAddr.slice(0, 10)}…`
    );
    console.error("[attach] Last error:", lastErr);
    process.exit(1);
  }
  console.log("[attach] PASS — wallet updated.");
  console.log(
    "  additional_signers:",
    JSON.stringify(updated.additional_signers, null, 2)
  );
}

main().catch((err) => {
  console.error("[attach] failed:", err);
  process.exit(1);
});
