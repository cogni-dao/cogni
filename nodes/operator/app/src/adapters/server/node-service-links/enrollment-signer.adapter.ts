// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-service-links/enrollment-signer.adapter`
 * Purpose: Sign `service.enrollment.v1` tokens with the operator's EdDSA attestation key (story.0038).
 * Scope: Signing only. The public half is the existing JWKS at `/.well-known/jwks.json`.
 * Invariants:
 *   - OWN_TOKEN_TYPE: the protected header `typ` is `cogni-service-enrollment+jwt`, never `JWT`, so the
 *     token cannot be replayed as an identity attestation (X's GitHub verifier rejects the `typ`).
 *   - SAME_KEY_NO_NEW_SECRET: reuses the attestation signing key; no new credential is introduced.
 * Side-effects: none (pure signing over an injected key)
 * Links: identity-attestation.adapter.ts, story.0038
 * @internal
 */

import type { KeyObject } from "node:crypto";
import {
  SERVICE_ENROLLMENT_JWT_TYP,
  type ServiceEnrollmentClaims,
} from "@cogni/node-contracts";
import { SignJWT } from "jose";
import type { ServiceEnrollmentSignerPort } from "@/ports";
import {
  ATTESTATION_ALG,
  attestationKeyId,
} from "@/shared/identity/attestation-keys";

export class JoseServiceEnrollmentSigner
  implements ServiceEnrollmentSignerPort
{
  constructor(private readonly signingKey: KeyObject) {}

  async sign(claims: ServiceEnrollmentClaims): Promise<string> {
    const kid = await attestationKeyId(this.signingKey);
    return new SignJWT({ ...claims })
      .setProtectedHeader({
        alg: ATTESTATION_ALG,
        typ: SERVICE_ENROLLMENT_JWT_TYP,
        kid,
      })
      .sign(this.signingKey);
  }
}
