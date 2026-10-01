// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Live catalog and Ed25519 signing adapters for identity attestations. */

import type { KeyObject } from "node:crypto";
import type { NodeActionClaims } from "@cogni/node-contracts";
import { SignJWT } from "jose";
import type {
  DeployPlanePort,
  IdentityAttestationJwtClaims,
  IdentityAttestationRepositoryPort,
  IdentityAttestationSignerPort,
  NodeActionSignerPort,
} from "@/ports";
import {
  ATTESTATION_ALG,
  attestationKeyId,
} from "@/shared/identity/attestation-keys";

export interface OperatorIdentityAttestationRepositoryConfig {
  readonly parentOwner: string;
  readonly parentRepo: string;
}

/**
 * Reads one node from the `nodes` projection. Returns null when the row is absent
 * (including on read failure) so the caller falls back rather than failing open.
 */
export type FindNodeRow = (nodeId: string) => Promise<{
  readonly id: string;
  readonly slug: string;
  readonly deployEnvs: readonly string[];
} | null>;

/**
 * Short-TTL cache for the merged-catalog read.
 *
 * The read is an App-authenticated GitHub fetch of `main`, and it sits on the entry
 * leg BEFORE the human reaches GitHub — so its latency is user-visible. Measured at
 * ~10.7s per request on candidate-a, which reads as broken.
 *
 * Caching keeps the "read `main` directly rather than the eventually-consistent
 * registry projection" property that motivated the App-read: the window is bounded by
 * TTL, not by projection lag, and a newly registered node becomes attestable within
 * one TTL — far inside any human's register-then-use loop. The corresponding risk is
 * that a node REMOVED from the catalog stays attestable for up to one TTL; catalog
 * removal is not a security revocation path today, and the attestation is still bound
 * to that node's registered origin.
 */
const CATALOG_TTL_MS = 60_000;
type CatalogNodes = Awaited<ReturnType<DeployPlanePort["listCatalogNodes"]>>;

const catalogCache = new Map<
  string,
  { readonly at: number; readonly nodes: CatalogNodes }
>();

/**
 * Resolve relying nodes from the environment-local parent's merged catalog.
 * Identity issuance is rare and security-sensitive, so each request reads `main`
 * directly instead of trusting the eventually-consistent catalog registry
 * projection. This adapter touches no user data — the attested subject comes from
 * the GitHub authorization response, not from the operator's database (task.5024).
 */
export class OperatorIdentityAttestationRepository
  implements IdentityAttestationRepositoryPort
{
  constructor(
    private readonly deployPlane: Pick<DeployPlanePort, "listCatalogNodes">,
    private readonly config: OperatorIdentityAttestationRepositoryConfig,
    /**
     * Fast path. Absent in tests that only exercise catalog behaviour.
     */
    private readonly findNodeRow?: FindNodeRow
  ) {}

  private async catalogNodes(): Promise<CatalogNodes> {
    const key = `${this.config.parentOwner}/${this.config.parentRepo}@main`;
    const hit = catalogCache.get(key);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.nodes;

    const nodes = await this.deployPlane.listCatalogNodes({
      parentOwner: this.config.parentOwner,
      parentRepo: this.config.parentRepo,
      sourceRef: "main",
    });
    catalogCache.set(key, { at: Date.now(), nodes });
    return nodes;
  }

  /**
   * `nodes` in Postgres FIRST, the App-authenticated catalog read only as a fallback.
   *
   * bug.5063: this lookup sits on the interactive auth path, in front of a human, and
   * the catalog read is an App JWT exchange plus a fetch per catalog file — measured
   * at 11.0s cold against 0.22s warm on candidate-a. A human reads 11s as broken; they
   * said so.
   *
   * The projection is safe to lead with. `identity-model.md` fixes `nodes.id` AS the
   * repo-spec `node_id` — not a surrogate — so the row is keyed by the same identity the
   * request names, and `deploy_envs` is the same list the allowlist needs.
   * `catalog-registry-reconcile` re-reads merged git on a ten-minute poll, so staleness
   * is bounded by that interval rather than unbounded.
   *
   * The fallback is what makes leading with it correct: a node registered within the
   * last poll window is missing from the projection, and would otherwise be rejected as
   * `unknown_node` — a fail-CLOSED error, but the wrong one. On a miss we pay the slow
   * read once rather than lie about the node not existing.
   */
  async findNode(nodeId: string) {
    if (this.findNodeRow) {
      const row = await this.findNodeRow(nodeId);
      if (row) {
        return {
          nodeId: row.id,
          slug: row.slug,
          deployEnvs: row.deployEnvs,
        };
      }
    }

    // A catalog read failure must not escape as a 500 on the interactive auth path.
    // On preview the App is not installed on the configured repo, so this threw
    // `GitHub App not installed ... (HTTP 404)` straight through the broker route
    // (bug.5073). Returning null keeps the caller's fail-CLOSED `unknown_node`, which
    // is the honest answer: this operator cannot verify the node.
    let nodes: CatalogNodes;
    try {
      nodes = await this.catalogNodes();
    } catch {
      return null;
    }
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

/** Same environment Ed25519 custody, different frozen claim protocol and audience. */
export class JoseNodeActionSigner implements NodeActionSignerPort {
  constructor(private readonly signingKey: KeyObject) {}

  async sign(claims: NodeActionClaims): Promise<string> {
    const kid = await attestationKeyId(this.signingKey);
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: ATTESTATION_ALG, typ: "JWT", kid })
      .sign(this.signingKey);
  }
}
