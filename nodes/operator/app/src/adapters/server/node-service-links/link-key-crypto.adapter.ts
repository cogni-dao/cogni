// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-service-links/link-key-crypto.adapter`
 * Purpose: The ephemeral X25519 key a link seals its key to, and the JWE open (story.0038).
 * Scope: Key generation and `CompactDecrypt` (ECDH-ES, A256GCM) with `jose`. No IO, no storage.
 * Invariants:
 *   - EPHEMERAL_PER_LINK: one keypair per link start; the private half is stored AEAD-encrypted and
 *     deleted when the link connects.
 *   - ALGORITHMS_PINNED: only `ECDH-ES` with `A256GCM` is accepted; any other header fails closed.
 *   - KEY_NOT_LOGGED: the opened key is returned to the link step only; errors carry no plaintext.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, story.0038
 * @internal
 */

import { compactDecrypt, exportJWK, generateKeyPair, importJWK } from "jose";
import type { ServiceKeyCryptoPort } from "@/ports";

const KEY_PATTERN = /^cogni_ag_sk_v[12]_[A-Za-z0-9_-]+$/;

export class JoseServiceKeyCrypto implements ServiceKeyCryptoPort {
  async generateLinkKeypair() {
    const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", {
      crv: "X25519",
      extractable: true,
    });
    const pub = await exportJWK(publicKey);
    if (pub.kty !== "OKP" || pub.crv !== "X25519" || !pub.x) {
      throw new Error("link_keypair_unexpected_shape");
    }
    return {
      publicJwk: { kty: "OKP" as const, crv: "X25519" as const, x: pub.x },
      privateJwk: (await exportJWK(privateKey)) as Record<string, unknown>,
    };
  }

  async openSealedKey(
    jwe: string,
    privateJwk: Record<string, unknown>
  ): Promise<string> {
    const privateKey = await importJWK(privateJwk as never, "ECDH-ES");
    const { plaintext } = await compactDecrypt(jwe, privateKey, {
      keyManagementAlgorithms: ["ECDH-ES"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    const text = new TextDecoder().decode(plaintext).trim();
    // X seals the bare key (no envelope).
    const candidate = text;
    if (!KEY_PATTERN.test(candidate)) throw new Error("sealed_key_unreadable");
    return candidate;
  }
}
