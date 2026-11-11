// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/crypto/aead`
 * Purpose: AEAD encrypt/decrypt for connection credentials using AES-256-GCM.
 * Scope: Pure crypto utility. Does NOT perform I/O, DB access, or env reads.
 * Invariants:
 * - ENCRYPTED_AT_REST: AES-256-GCM with 12-byte random nonce prepended to ciphertext.
 * - AAD_BINDING: Additional Authenticated Data binds ciphertext to {billing_account_id, connection_id, provider[, audience]}.
 *   Prevents ciphertext rebind across tenants or connections.
 * - KEY_FROM_CALLER: Key is passed in, not read from env. Caller (adapter) is responsible for key provisioning.
 * Side-effects: none (pure crypto)
 * Links: docs/spec/tenant-connections.md (invariant 4)
 * @public
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export interface AeadAAD {
  readonly billing_account_id: string;
  readonly connection_id: string;
  readonly provider: string;
  /**
   * Service origin a `cogni-node` key is valid for (story.0038). Bound only when set: a null or
   * absent audience is left OUT of the JSON, so every row encrypted before this field existed still
   * decrypts with its original bound data.
   */
  readonly audience?: string | null;
}

/** Canonical bound-data bytes: the caller's field order, with a null/absent `audience` omitted. */
function aadBytes(aad: AeadAAD): Buffer {
  const { audience, ...rest } = aad;
  const bound =
    audience === null || audience === undefined ? rest : { ...rest, audience };
  return Buffer.from(JSON.stringify(bound), "utf-8");
}

/**
 * Encrypt plaintext with AES-256-GCM and AAD binding.
 * Returns nonce + ciphertext + authTag concatenated.
 */
export function aeadEncrypt(
  plaintext: string,
  aad: AeadAAD,
  key: Buffer
): Buffer {
  const nonce = randomBytes(NONCE_LENGTH);
  const aadBuffer = aadBytes(aad);
  const cipher = createCipheriv(ALGORITHM, key, nonce, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  cipher.setAAD(aadBuffer);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // nonce (12) + ciphertext (variable) + authTag (16)
  return Buffer.concat([nonce, encrypted, authTag]);
}

/**
 * Decrypt ciphertext encrypted with aeadEncrypt.
 * Validates AAD binding — throws if AAD doesn't match (ciphertext rebind attack).
 */
export function aeadDecrypt(
  ciphertext: Buffer,
  aad: AeadAAD,
  key: Buffer
): string {
  if (ciphertext.length < NONCE_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("AEAD ciphertext too short");
  }

  const nonce = ciphertext.subarray(0, NONCE_LENGTH);
  const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_LENGTH);
  const encrypted = ciphertext.subarray(
    NONCE_LENGTH,
    ciphertext.length - AUTH_TAG_LENGTH
  );

  const aadBuffer = aadBytes(aad);
  const decipher = createDecipheriv(ALGORITHM, key, nonce, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAAD(aadBuffer);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf-8");
}
