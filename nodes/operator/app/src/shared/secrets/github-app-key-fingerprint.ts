// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/secrets/github-app-key-fingerprint`
 * Purpose: Non-secret identity for a GitHub App private key — the SHA-256 of its
 *   PUBLIC half (SPKI DER), hex-encoded. This is the only representation of key
 *   material that may appear in logs, typed results, Loki, or work items
 *   (subtask.5016; the bug.5142 credential-fingerprint class).
 * Scope: Pure crypto derivation. No IO, no GitHub, no OpenBao.
 * Invariants:
 *   - NO_MATERIAL_ESCAPES: failures return a typed reason; no error message ever
 *     embeds the input bytes. The fingerprint is derived from the PUBLIC key, so
 *     publishing it leaks nothing a GitHub App page does not already imply.
 *   - DETERMINISTIC: same PEM (any base64 wrapping) → same fingerprint, so two
 *     custodies (OpenBao vs the live pod env) can be compared without values.
 * Side-effects: none
 * Links: docs/spec/secrets-management.md (Invariant 4), subtask.5016 audit record
 * @public
 */

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

export type AppKeyFingerprintResult =
  | { readonly ok: true; readonly fingerprint: string }
  | {
      readonly ok: false;
      readonly reason: "empty" | "invalid_base64" | "invalid_key_material";
    };

/**
 * Fingerprint a base64-encoded PEM private key (the `GH_REVIEW_APP_PRIVATE_KEY_BASE64`
 * wire shape): sha256(SPKI DER of the public half), lowercase hex.
 */
export function fingerprintAppPrivateKeyBase64(
  privateKeyBase64: string
): AppKeyFingerprintResult {
  if (privateKeyBase64.trim() === "") return { ok: false, reason: "empty" };
  let pem: string;
  try {
    pem = Buffer.from(privateKeyBase64, "base64").toString("utf-8");
  } catch {
    return { ok: false, reason: "invalid_base64" };
  }
  // Buffer.from never throws on bad base64 — it silently decodes a prefix. A
  // non-PEM result is caught by key parsing below; an empty decode is caught here.
  if (pem.trim() === "") return { ok: false, reason: "invalid_base64" };
  try {
    const privateKey = createPrivateKey(pem);
    const publicKey = createPublicKey(privateKey);
    const spkiDer = publicKey.export({ type: "spki", format: "der" });
    return {
      ok: true,
      fingerprint: createHash("sha256").update(spkiDer).digest("hex"),
    };
  } catch {
    // Deliberately swallow the crypto error object: node:crypto messages can echo
    // fragments of the input. The typed reason is the whole diagnostic.
    return { ok: false, reason: "invalid_key_material" };
  }
}

/** Decode the wire shape to PEM, or null when it is not valid key material. */
export function decodeAppPrivateKeyPem(
  privateKeyBase64: string
): string | null {
  if (privateKeyBase64.trim() === "") return null;
  const pem = Buffer.from(privateKeyBase64, "base64").toString("utf-8");
  try {
    createPrivateKey(pem);
    return pem;
  } catch {
    return null;
  }
}
