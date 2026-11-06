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
  IdentityAttestationGithubIdentity,
  IdentityAttestationRepositoryPort,
  IdentityAttestationSignerPort,
} from "@/ports";
import { hostForEnv, isFlightEnv } from "@/shared/node-registry/deploy-hosts";

export type AttestationPreconditionCode =
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

export interface ResolvedAttestationNode {
  readonly nodeId: string;
  readonly slug: string;
}

export interface IdentityAttestationService {
  /**
   * Registered-node + registered-origin policy, evaluated BEFORE the user is sent to
   * GitHub so an unknown node or unregistered origin fails immediately instead of
   * after an authentication the caller can never use.
   */
  resolveNode(params: {
    request: IdentityAttestationRequest;
  }): Promise<ResolvedAttestationNode>;
  issue(params: {
    /**
     * The GitHub identity authenticated by the authorization response for THIS request.
     * Never an ambient operator session, and never a stored binding — that conflation is
     * the confused deputy this service exists to prevent (task.5024).
     */
    github: IdentityAttestationGithubIdentity;
    issuer: string;
    request: IdentityAttestationRequest;
  }): Promise<IssuedAttestation>;
}

export function createIdentityAttestationService(deps: {
  repository: IdentityAttestationRepositoryPort;
  signer: IdentityAttestationSignerPort;
  clock: Clock;
  createJti: () => string;
  fleetZoneBindings: readonly {
    readonly fleetOwner: string;
    readonly zoneName: string;
  }[];
}): IdentityAttestationService {
  async function resolveNode(params: {
    request: IdentityAttestationRequest;
  }): Promise<ResolvedAttestationNode> {
    const targetNode = await deps.repository.findNode(params.request.nodeId);
    if (!targetNode || targetNode.nodeId !== params.request.nodeId) {
      throw new AttestationPreconditionError("unknown_node");
    }

    const matches = deps.fleetZoneBindings.filter(
      (binding) => binding.fleetOwner === targetNode.repoOwner
    );
    if (matches.length !== 1)
      throw new AttestationPreconditionError("invalid_target_origin");
    const deployRootDomain = matches[0]?.zoneName;
    if (!deployRootDomain)
      throw new AttestationPreconditionError("invalid_target_origin");
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

    return { nodeId: targetNode.nodeId, slug: targetNode.slug };
  }

  return {
    resolveNode,
    async issue(params) {
      const targetNode = await resolveNode({
        request: params.request,
      });

      const iat = Math.floor(Date.parse(deps.clock.now()) / 1000);
      const claims = IdentityAttestationClaimsSchema.parse({
        type: IDENTITY_ATTESTATION_V1,
        protocol: IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
        iss: params.issuer,
        aud: identityAttestationAudience(targetNode.nodeId),
        nodeId: targetNode.nodeId,
        nonce: params.request.nonce,
        targetOrigin: params.request.targetOrigin,
        github: params.github,
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
