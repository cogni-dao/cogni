// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/owner-key`
 * Purpose: Browser-side P-256 owner key for the node wallet (story.0083): generate it, turn it into a
 *   recovery file, load a recovery file back, and prove the loaded file really holds the key.
 * Scope: WebCrypto only (`globalThis.crypto.subtle`). No network, no storage, no React.
 * Invariants:
 *   - KEY_STAYS_IN_THE_BROWSER: nothing here sends, stores or logs the private key. The recovery file is
 *     the one place it leaves memory, as a download the node owner keeps.
 *   - NO_STORAGE: no localStorage / sessionStorage / IndexedDB / cookies.
 *   - PUBLIC_KEY_ONLY_OUTWARD: the only value meant to leave the page is the base64 SPKI public key.
 *   - PROOF_BEFORE_CREATE: `proveRecoveryFile` signs a random challenge with the LOADED file's key and
 *     verifies it against the expected public key; the caller creates nothing until it returns true.
 * Side-effects: none (the caller triggers the download and the request)
 * Links: src/features/nodes/wizard/steps/NodeWalletCreate.client.tsx, src/app/api/v1/nodes/[id]/node-wallet/route.ts
 * @public
 */

const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SHA256 = { name: "ECDSA", hash: "SHA-256" } as const;
const PEM_LABEL = "PRIVATE KEY";

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available in this browser");
  return s;
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export interface GeneratedOwnerKey {
  /** Base64 DER SPKI public key: the only value sent to the operator. */
  readonly spkiBase64: string;
  /** PEM-wrapped PKCS8 private key: the recovery file body. Download it, then drop it. */
  readonly recoveryPem: string;
}

/** `<slug>-wallet-owner.pem` */
export function recoveryFileName(slug: string): string {
  return `${slug}-wallet-owner.pem`;
}

export function wrapPem(pkcs8Base64: string): string {
  const lines = pkcs8Base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${PEM_LABEL}-----\n${lines.join("\n")}\n-----END ${PEM_LABEL}-----\n`;
}

/** Extract the base64 PKCS8 body from a PEM file; null when the text is not a single PRIVATE KEY PEM. */
export function unwrapPem(pem: string): string | null {
  const match = new RegExp(
    `^\\s*-----BEGIN ${PEM_LABEL}-----([A-Za-z0-9+/=\\s]+)-----END ${PEM_LABEL}-----\\s*$`
  ).exec(pem);
  const body = match?.[1]?.replace(/\s+/g, "");
  return body ? body : null;
}

/** Generate an extractable ECDSA P-256 pair and export it. The CryptoKeys are not kept. */
export async function generateOwnerKey(): Promise<GeneratedOwnerKey> {
  const pair = await subtle().generateKey(ECDSA_P256, true, ["sign", "verify"]);
  const [spki, pkcs8] = await Promise.all([
    subtle().exportKey("spki", pair.publicKey),
    subtle().exportKey("pkcs8", pair.privateKey),
  ]);
  return {
    spkiBase64: toBase64(spki),
    recoveryPem: wrapPem(toBase64(pkcs8)),
  };
}

export interface LoadedRecoveryFile {
  readonly privateKey: CryptoKey;
  /** The public key derived from the file's private key (base64 DER SPKI). */
  readonly spkiBase64: string;
}

/** Parse a recovery file: PEM PKCS8 -> P-256 private key -> its public SPKI. Throws on anything else. */
export async function loadRecoveryFile(
  pemText: string
): Promise<LoadedRecoveryFile> {
  const body = unwrapPem(pemText);
  if (!body) throw new Error("not_a_recovery_file");
  const privateKey = await subtle().importKey(
    "pkcs8",
    fromBase64(body),
    ECDSA_P256,
    true,
    ["sign"]
  );
  // A P-256 private JWK carries the public point (x, y); that is how the public key is recovered.
  const jwk = await subtle().exportKey("jwk", privateKey);
  if (!jwk.x || !jwk.y) throw new Error("not_a_recovery_file");
  const publicKey = await subtle().importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
    ECDSA_P256,
    true,
    ["verify"]
  );
  const spki = await subtle().exportKey("spki", publicKey);
  return { privateKey, spkiBase64: toBase64(spki) };
}

/**
 * Sign a random challenge with the loaded file's key and verify it against `expectedSpkiBase64`.
 * True only when the file holds the private half of that exact public key.
 */
export async function proveRecoveryFile(
  loaded: LoadedRecoveryFile,
  expectedSpkiBase64: string
): Promise<boolean> {
  if (loaded.spkiBase64 !== expectedSpkiBase64) return false;
  const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const signature = await subtle().sign(
    ECDSA_SHA256,
    loaded.privateKey,
    challenge
  );
  const expectedPublic = await subtle().importKey(
    "spki",
    fromBase64(expectedSpkiBase64),
    ECDSA_P256,
    false,
    ["verify"]
  );
  return subtle().verify(ECDSA_SHA256, expectedPublic, signature, challenge);
}
