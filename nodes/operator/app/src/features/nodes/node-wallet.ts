// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/node-wallet`
 * Purpose: Pure rules for the wizard's "Create node wallet" step (story.0083): validate the owner
 *   public key the browser sends, hash it, build the Privy idempotency key, and check the request
 *   came from this app's own origin.
 * Scope: No IO, no env. The route owns auth, the database, Privy and GitHub.
 * Invariants:
 *   - PUBLIC_KEY_ONLY: the only key material this module touches is a base64 DER SPKI P-256 PUBLIC key.
 *   - STRICT_P256_SPKI: the bytes must parse as an SPKI public key on the prime256v1 curve; nothing
 *     else (private keys, other curves, PEM text) is accepted.
 *   - NO_KEY_IN_LOGS: nothing here returns or logs the key; callers log the hash prefix at most.
 * Side-effects: none
 * Links: src/app/api/v1/nodes/[id]/node-wallet/route.ts, https://node-template.cognidao.org/knowledge/set-up-operator-wallet
 * @public
 */

import { createHash, createPublicKey } from "node:crypto";

/** An SPKI P-256 public key is 91 bytes; bound the input so the parser never sees a large body. */
const MAX_SPKI_BASE64_LENGTH = 256;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type OwnerPublicKeyResult =
  | {
      readonly ok: true;
      /** Canonical re-encoding of the key (base64 DER SPKI), the value sent to Privy. */
      readonly spkiBase64: string;
      /** Hex sha256 of the DER bytes; pins a node row to this owner key. */
      readonly keySha256: string;
    }
  | { readonly ok: false; readonly reason: "invalid_public_key" };

const INVALID: OwnerPublicKeyResult = {
  ok: false,
  reason: "invalid_public_key",
};

/** Accept only a base64 DER SPKI public key on P-256 (prime256v1). */
export function parseOwnerPublicKey(value: unknown): OwnerPublicKeyResult {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SPKI_BASE64_LENGTH ||
    !BASE64_RE.test(value)
  ) {
    return INVALID;
  }
  try {
    const der = Buffer.from(value, "base64");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (
      key.asymmetricKeyType !== "ec" ||
      key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      return INVALID;
    }
    // Hash and forward the canonical encoding, not the caller's bytes: one key, one hash.
    const canonical = key.export({ format: "der", type: "spki" });
    return {
      ok: true,
      spkiBase64: canonical.toString("base64"),
      keySha256: createHash("sha256").update(canonical).digest("hex"),
    };
  } catch {
    return INVALID;
  }
}

/** `privy-idempotency-key`: one wallet per (lane, registry row, owner key). */
export function nodeWalletIdempotencyKey(input: {
  readonly env: string;
  readonly rowId: string;
  readonly keySha256: string;
}): string {
  return `node-wallet:${input.env}:${input.rowId}:${input.keySha256}`;
}

/**
 * The request must come from this app's own origin. A missing `Origin` fails: a browser always sends
 * it on a cross-site POST, and a same-origin fetch POST sends it too.
 */
export function isSameOriginRequest(input: {
  readonly origin: string | null;
  readonly allowedOrigins: readonly string[];
}): boolean {
  if (!input.origin) return false;
  return input.allowedOrigins.includes(input.origin);
}

/** The origin this request reached us through (forwarded headers first), as the proxy sees it. */
export function requestPublicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    url.host;
  const proto = (
    request.headers.get("x-forwarded-proto")?.split(",")[0] ??
    url.protocol.replace(":", "")
  ).trim();
  return `${proto}://${host.split(",")[0]?.trim()}`;
}
