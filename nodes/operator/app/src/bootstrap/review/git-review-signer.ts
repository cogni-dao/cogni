// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/review/git-review-signer`
 * Purpose: The one signer git-review uses to call a linked node (task.5448). It signs a short-lived
 *   assertion per call (`sub` git-review, `aud` the target node id, `scope` knowledge:read); the public
 *   half is served at /.well-known/jwks.json beside the attestation key.
 * Scope: Builds the signer once from `GIT_REVIEW_SIGNING_SEED` and the operator's canonical https origin
 *   and caches it. Signing runs in the app (graph runs execute there), never in the worker.
 * Invariants:
 *   - OWN_KEY: separate from the identity-attestation key; its kid is its own RFC 7638 thumbprint.
 *   - FAIL_CLOSED: an unset or malformed seed, or an issuer that is not a canonical https origin, is a typed
 *     result (`signer_unavailable`), never a thrown error and never an unsigned call.
 *   - NO_SECRET_IN_RESULTS: no result, log or error carries the seed.
 *   - BUILT_ONCE: one signer per (issuer, seed); a failed build is not cached.
 * Side-effects: none (Web Crypto key derivation only)
 * Links: https://cognidao.org/knowledge/operator-identity-model, infra/secrets-catalog.yaml GIT_REVIEW_SIGNING_SEED
 * @internal
 */

import {
  createServiceAssertionSignerFromSeed,
  isCanonicalHttpsOrigin,
  type ServiceAssertionSigner,
} from "@cogni-dao/agent-grants/service-auth";

/** The service slug git-review signs as (`sub`). */
export const GIT_REVIEW_SERVICE = "git-review" as const;
/** The only scope a git-review read asks for. */
export const GIT_REVIEW_SCOPE = "knowledge:read" as const;

export type GitReviewSignerResult =
  | { readonly ok: true; readonly signer: ServiceAssertionSigner }
  | {
      readonly ok: false;
      readonly reason: "seed_missing" | "seed_invalid" | "issuer_invalid";
    };

let cache:
  | { readonly key: string; readonly signer: Promise<ServiceAssertionSigner> }
  | undefined;

/** The operator's canonical https origin from its public base URL, or undefined when it is not one. */
export function canonicalOperatorOrigin(
  appBaseUrl: string | undefined
): string | undefined {
  if (!appBaseUrl) return undefined;
  try {
    const origin = new URL(appBaseUrl).origin;
    return isCanonicalHttpsOrigin(origin) ? origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The cached git-review signer, built on first use.
 * `seedHex` and `appBaseUrl` come from `serverEnv()`; they are parameters so tests build without env.
 */
export async function getGitReviewSigner(input: {
  readonly seedHex: string | undefined;
  readonly appBaseUrl: string | undefined;
}): Promise<GitReviewSignerResult> {
  if (!input.seedHex) return { ok: false, reason: "seed_missing" };
  const issuer = canonicalOperatorOrigin(input.appBaseUrl);
  if (!issuer) return { ok: false, reason: "issuer_invalid" };
  const key = `${issuer}\n${input.seedHex}`;
  let entry = cache;
  if (!entry || entry.key !== key) {
    const signer = createServiceAssertionSignerFromSeed({
      issuer,
      seedHex: input.seedHex,
    });
    entry = { key, signer };
    cache = entry;
    const built = entry;
    // A failed build is not cached: the next call tries again (the secret may be fixed).
    signer.catch(() => {
      if (cache === built) cache = undefined;
    });
  }
  try {
    return { ok: true, signer: await entry.signer };
  } catch {
    return { ok: false, reason: "seed_invalid" };
  }
}

/** Test seam: forget the cached signer. */
export function resetGitReviewSignerCache(): void {
  cache = undefined;
}
