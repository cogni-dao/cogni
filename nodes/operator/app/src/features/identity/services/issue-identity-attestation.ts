// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Policy service for issuing one deployment-bound fleet identity attestation. */

import {
  IDENTITY_ATTESTATION_TTL_SECONDS,
  IDENTITY_ATTESTATION_V1,
  IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
  IdentityAttestationClaimsSchema,
  type IdentityAttestationRequest,
  identityAttestationAudience,
} from "@cogni/node-contracts";

import type {
  Clock,
  IdentityAttestationRepositoryPort,
  IdentityAttestationSignerPort,
} from "@/ports";
import {
  hostForEnv,
  isFlightEnv,
  rootDomain,
} from "@/shared/node-registry/deploy-hosts";

export type AttestationPreconditionCode =
  | "no_github_binding"
  | "no_wallet"
  | "invalid_target_origin"
  | "unknown_node";

export class AttestationPreconditionError extends Error {
  constructor(readonly code: AttestationPreconditionCode) {
    super(code);
    this.name = "AttestationPreconditionError";
  }
}

export interface IssuedAttestation {
  attestation: string;
  expiresIn: number;
}

export interface IdentityAttestationService {
  issue(params: {
    userId: string;
    fallbackWalletAddress: string | null;
    issuer: string;
    domain: string;
    request: IdentityAttestationRequest;
  }): Promise<IssuedAttestation>;
}

export function createIdentityAttestationService(deps: {
  repository: IdentityAttestationRepositoryPort;
  signer: IdentityAttestationSignerPort;
  clock: Clock;
  createJti: () => string;
}): IdentityAttestationService {
  return {
    async issue(params) {
      const targetNode = await deps.repository.findNode(params.request.nodeId);
      if (!targetNode || targetNode.nodeId !== params.request.nodeId) {
        throw new AttestationPreconditionError("unknown_node");
      }

      const deployRootDomain = rootDomain(params.domain);
      const registeredOrigins = targetNode.deployEnvs
        .filter(isFlightEnv)
        .map(
          (deployEnv) =>
            `https://${hostForEnv(
              targetNode.slug,
              targetNode.slug === "operator",
              deployEnv,
              deployRootDomain
            )}`
        );
      if (!registeredOrigins.includes(params.request.targetOrigin)) {
        throw new AttestationPreconditionError("invalid_target_origin");
      }

      const subject = await deps.repository.findSubject(
        params.userId,
        params.fallbackWalletAddress
      );
      if (!subject.walletAddress) {
        throw new AttestationPreconditionError("no_wallet");
      }
      if (!subject.github) {
        throw new AttestationPreconditionError("no_github_binding");
      }

      const iat = Math.floor(Date.parse(deps.clock.now()) / 1000);
      const claims = IdentityAttestationClaimsSchema.parse({
        type: IDENTITY_ATTESTATION_V1,
        protocol: IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
        iss: params.issuer,
        sub: params.userId,
        aud: identityAttestationAudience(targetNode.nodeId),
        nodeId: targetNode.nodeId,
        nonce: params.request.nonce,
        targetOrigin: params.request.targetOrigin,
        wallet: subject.walletAddress.toLowerCase(),
        github: subject.github,
        iat,
        exp: iat + IDENTITY_ATTESTATION_TTL_SECONDS,
        jti: deps.createJti(),
      });
      return {
        attestation: await deps.signer.sign(claims),
        expiresIn: IDENTITY_ATTESTATION_TTL_SECONDS,
      };
    },
  };
}
