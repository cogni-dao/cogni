// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/.well-known/jwks.json`
 * Purpose: Public JWKS document for operator-signed identity attestations
 *   (task.5024) — nodes verify attestation JWTs against these keys.
 * Scope: Single GET handler serving the signing key's public half
 *   (kid = RFC 7638 thumbprint). Public endpoint — no auth, like agent.json
 *   (/.well-known is outside the proxy matcher).
 * Invariants:
 *   - NEVER_500: unset or malformed IDENTITY_ATTESTATION_PRIVATE_KEY serves
 *     `{ keys: [] }` — verifiers fail closed on an empty set.
 *   - PUBLIC_HALF_ONLY: only the exported public JWK ever leaves this route.
 * Side-effects: none
 * Links: docs/spec/decentralized-user-identity.md, src/shared/identity/attestation-keys.ts
 * @public
 */

import { NextResponse } from "next/server";
import { serverEnv } from "@/shared/env";
import {
  attestationPublicJwks,
  importAttestationSigningKey,
} from "@/shared/identity/attestation-keys";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=600";

export async function GET() {
  const env = serverEnv();
  const headers = { "cache-control": CACHE_CONTROL };

  if (!env.IDENTITY_ATTESTATION_PRIVATE_KEY) {
    return NextResponse.json({ keys: [] }, { headers });
  }

  try {
    const signingKey = importAttestationSigningKey(
      env.IDENTITY_ATTESTATION_PRIVATE_KEY
    );
    const jwks = await attestationPublicJwks(signingKey);
    return NextResponse.json(jwks, { headers });
  } catch {
    return NextResponse.json({ keys: [] }, { headers });
  }
}
