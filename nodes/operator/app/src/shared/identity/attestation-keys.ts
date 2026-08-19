// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/identity/attestation-keys`
 * Purpose: Ed25519 key handling for operator-signed identity attestations —
 *   derives a signing keypair from one private seed and exposes only its public
 *   half as a JWKS document.
 * Scope: Pure key material transforms (seed → KeyObject → public JWK + kid).
 *   Does not read env, sign tokens, or touch the database.
 * Invariants:
 *   - SEED_IS_32_BYTES: each env value is a canonical base64-encoded 32-byte Ed25519 seed
 *     (catalog `generate: { kind: base64, bytes: 32 }`); anything else throws
 *     so callers fail closed (503 attestation_unavailable).
 *   - KID_IS_RFC7638_THUMBPRINT: kid derives from the public JWK thumbprint —
 *     stable across restarts, changes iff the key rotates.
 *   - ASYMMETRIC_ONLY: EdDSA on purpose — a shared HMAC would let any node
 *     forge attestations for its peers (the SCHEDULER_API_TOKEN defect).
 * Side-effects: none
 * Links: docs/spec/decentralized-user-identity.md, infra/secrets-catalog.yaml
 * @public
 */

import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

import { calculateJwkThumbprint, exportJWK, type JWK } from "jose";

/** PKCS#8 DER prefix for an Ed25519 private key (RFC 8410) — the raw 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
);
const ED25519_SEED_BYTES = 32;

export const ATTESTATION_ALG = "EdDSA" as const;

export interface AttestationJwk extends JWK {
  kid: string;
  alg: typeof ATTESTATION_ALG;
  use: "sig";
}

/**
 * Import the base64-encoded 32-byte Ed25519 seed as a signing KeyObject.
 * Throws on malformed input (wrong length / not base64) — callers map the
 * failure to 503 attestation_unavailable rather than signing with garbage.
 */
export function importAttestationSigningKey(base64Seed: string): KeyObject {
  const normalized = base64Seed.trim();
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) ||
    normalized.length % 4 !== 0
  ) {
    throw new Error(
      `identity attestation private key must be canonical base64 for a ${ED25519_SEED_BYTES}-byte Ed25519 seed`
    );
  }
  const seed = Buffer.from(normalized, "base64");
  if (
    seed.length !== ED25519_SEED_BYTES ||
    seed.toString("base64") !== normalized
  ) {
    throw new Error(
      `identity attestation private key must be a canonical base64-encoded ${ED25519_SEED_BYTES}-byte Ed25519 seed (got ${seed.length} bytes)`
    );
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/**
 * Export a JWKS containing the signing key's public half.
 */
export async function attestationPublicJwks(
  signingKey: KeyObject
): Promise<{ keys: AttestationJwk[] }> {
  const publicJwk = await exportJWK(createPublicKey(signingKey));
  const kid = await calculateJwkThumbprint(publicJwk);
  return {
    keys: [
      {
        ...publicJwk,
        kid,
        alg: ATTESTATION_ALG,
        use: "sig",
      },
    ],
  };
}

/** kid of the signing key's public half (RFC 7638 thumbprint). */
export async function attestationKeyId(signingKey: KeyObject): Promise<string> {
  return calculateJwkThumbprint(await exportJWK(createPublicKey(signingKey)));
}
