// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/agent-claim-attestation`
 * Purpose: Verify an operator-issued, target-bound provider attestation for an existing-agent claim.
 * Scope: Local operator issuer composition only. Does not persist claims or choose stewardship.
 * Invariants: TARGET_NODE_BOUND; TARGET_ORIGIN_BOUND; SIGNATURE_REQUIRED; JTI_PERSISTED_BY_CLAIM.
 * Side-effects: none beyond environment reads.
 * Links: identity.attestation.v1.contract, story.5075
 * @internal
 */

import { createPublicKey } from "node:crypto";
import {
  IdentityAttestationClaimsSchema,
  IdentityAttestationOriginSchema,
  identityAttestationAudience,
  type IdentityAttestationClaims,
} from "@cogni/node-contracts";
import { jwtVerify } from "jose";
import { AgentIdentityError } from "@/ports";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";
import {
  ATTESTATION_ALG,
  importAttestationSigningKey,
} from "@/shared/identity/attestation-keys";

export async function verifyAgentClaimAttestation(
  token: string
): Promise<IdentityAttestationClaims> {
  const env = serverEnv();
  const issuer = IdentityAttestationOriginSchema.safeParse(env.APP_BASE_URL);
  if (!issuer.success || !env.IDENTITY_ATTESTATION_PRIVATE_KEY) {
    throw new AgentIdentityError(
      "claim_denied",
      "Identity attestation verification is unavailable"
    );
  }
  const nodeId = getNodeId();
  try {
    const signingKey = importAttestationSigningKey(
      env.IDENTITY_ATTESTATION_PRIVATE_KEY
    );
    const verified = await jwtVerify(token, createPublicKey(signingKey), {
      algorithms: [ATTESTATION_ALG],
      issuer: issuer.data,
      audience: identityAttestationAudience(nodeId),
    });
    const claims = IdentityAttestationClaimsSchema.parse(verified.payload);
    if (claims.nodeId !== nodeId || claims.targetOrigin !== issuer.data) {
      throw new Error("attestation target mismatch");
    }
    return claims;
  } catch {
    throw new AgentIdentityError(
      "claim_denied",
      "Identity attestation is invalid or not issued for this node"
    );
  }
}
