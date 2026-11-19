// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/.well-known/jwks.json`
 * Purpose: Public JWKS document for the operator's two signing keys: the identity-attestation key
 *   (task.5024, nodes verify attestation JWTs against it) and the git-review key (task.5448, a linked
 *   node verifies git-review's per-call assertions against it).
 * Scope: Single GET handler serving each configured key's public half (kid = RFC 7638 thumbprint, one
 *   kid per key). Public endpoint — no auth, like agent.json (/.well-known is outside the proxy matcher).
 * Invariants:
 *   - NEVER_500: an unset or malformed key serves nothing for that key; with both unset the body is
 *     `{ keys: [] }` — verifiers fail closed on an empty set.
 *   - ONE_KEY_FAILS_ALONE: one key unset or malformed never hides the other.
 *   - PUBLIC_HALF_ONLY: only the exported public JWK ever leaves this route.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/identity-attestation-v1, src/shared/identity/attestation-keys.ts,
 *   src/bootstrap/review/git-review-signer.ts
 * @public
 */

import { NextResponse } from "next/server";
import { getGitReviewSigner } from "@/bootstrap/review/git-review-signer";
import { serverEnv } from "@/shared/env";
import {
  attestationPublicJwks,
  importAttestationSigningKey,
} from "@/shared/identity/attestation-keys";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=600";

async function attestationKeys(
  seed: string | undefined
): Promise<readonly object[]> {
  if (!seed) return [];
  try {
    return (await attestationPublicJwks(importAttestationSigningKey(seed)))
      .keys;
  } catch {
    return [];
  }
}

async function reviewSigningKeys(
  seedHex: string | undefined,
  appBaseUrl: string | undefined
): Promise<readonly object[]> {
  try {
    const result = await getGitReviewSigner({ seedHex, appBaseUrl });
    return result.ok ? result.signer.jwks().keys : [];
  } catch {
    return [];
  }
}

export async function GET() {
  const env = serverEnv();
  const headers = { "cache-control": CACHE_CONTROL };
  const keys = [
    ...(await attestationKeys(env.IDENTITY_ATTESTATION_PRIVATE_KEY)),
    ...(await reviewSigningKeys(env.GIT_REVIEW_SIGNING_SEED, env.APP_BASE_URL)),
  ];
  return NextResponse.json({ keys }, { headers });
}
