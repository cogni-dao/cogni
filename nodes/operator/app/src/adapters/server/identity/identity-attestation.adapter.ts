// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Live catalog, Drizzle subject, and Ed25519 signing adapters for identity attestations. */

import type { KeyObject } from "node:crypto";

import { type Database, withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { and, desc, eq } from "drizzle-orm";
import { SignJWT } from "jose";

import type {
  DeployPlanePort,
  IdentityAttestationJwtClaims,
  IdentityAttestationRepositoryPort,
  IdentityAttestationSignerPort,
} from "@/ports";
import { userBindings, users } from "@/shared/db/schema";
import {
  ATTESTATION_ALG,
  attestationKeyId,
} from "@/shared/identity/attestation-keys";

export interface OperatorIdentityAttestationRepositoryConfig {
  readonly parentOwner: string;
  readonly parentRepo: string;
}

/**
 * Resolve relying nodes from the environment-local parent's merged catalog while
 * retaining tenant-scoped subject reads in the app database. Identity issuance
 * is rare and security-sensitive, so each request reads `main` directly instead
 * of trusting the eventually-consistent catalog registry projection.
 */
export class OperatorIdentityAttestationRepository
  implements IdentityAttestationRepositoryPort
{
  constructor(
    private readonly appDb: Database,
    private readonly deployPlane: Pick<DeployPlanePort, "listCatalogNodes">,
    private readonly config: OperatorIdentityAttestationRepositoryConfig
  ) {}

  async findNode(nodeId: string) {
    const nodes = await this.deployPlane.listCatalogNodes({
      parentOwner: this.config.parentOwner,
      parentRepo: this.config.parentRepo,
      sourceRef: "main",
    });
    const matches = nodes.filter((candidate) => candidate.nodeId === nodeId);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new Error(`merged catalog contains duplicate node id '${nodeId}'`);
    }
    const node = matches[0];
    if (!node) return null;
    return {
      nodeId: node.nodeId,
      slug: node.slug,
      deployEnvs: node.deployEnvs,
    };
  }

  async findSubject(userId: string, fallbackWalletAddress: string | null) {
    const actorId = userActor(userId as UserId);
    return withTenantScope(this.appDb, actorId, async (tx) => {
      const [bindings, user] = await Promise.all([
        tx
          .select({
            externalId: userBindings.externalId,
            providerLogin: userBindings.providerLogin,
          })
          .from(userBindings)
          .where(
            and(
              eq(userBindings.userId, userId),
              eq(userBindings.provider, "github")
            )
          )
          .orderBy(desc(userBindings.createdAt), desc(userBindings.id))
          .limit(1),
        tx.query.users.findFirst({
          where: eq(users.id, userId),
          columns: { walletAddress: true },
        }),
      ]);
      const binding = bindings[0];
      return {
        walletAddress: user?.walletAddress ?? fallbackWalletAddress,
        github: binding
          ? { id: binding.externalId, login: binding.providerLogin }
          : null,
      };
    });
  }
}

export class JoseIdentityAttestationSigner
  implements IdentityAttestationSignerPort
{
  constructor(private readonly signingKey: KeyObject) {}

  async sign(claims: IdentityAttestationJwtClaims): Promise<string> {
    const kid = await attestationKeyId(this.signingKey);
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: ATTESTATION_ALG, typ: "JWT", kid })
      .sign(this.signingKey);
  }
}
