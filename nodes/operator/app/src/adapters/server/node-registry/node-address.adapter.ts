// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/node-address`
 * Purpose: Implement {@link NodeAddressPort} — resolve a node's app base URL from the placement the
 *   node DECLARED in its catalog row and the operator projected into its own registry. Replaces the
 *   hardcoded `internalNodeAppUrl(slug)` assumption that every node is a cluster neighbour (bug.5106).
 * Scope: One registry read + the pure placement→address mapping. No fetch, no env read (the caller
 *   injects the apex + env), no catalog read at request time.
 * Invariants:
 *   - NODE_RESOLUTION_IS_A_DB_READ: placement comes from the operator's OWN registry projection
 *     (`nodes.deployment_providers`, written by the catalog reconcile job), never a static
 *     `COGNI_NODE_ENDPOINTS`-style map in the app and never a live catalog fetch on the hot path.
 *   - NO_NODE_NAMES_IN_CODE: no slug ever appears in a branch here. Moving a node between providers
 *     is one catalog edit + a reconcile — zero operator code changes.
 *   - UNKNOWN_NODE_IS_K3S: a slug with no registry row keeps the historical in-cluster address. The
 *     operator routes to nodes it has not yet projected (e.g. mid-reconcile), and regressing those
 *     to an error would be a strictly worse failure than today's behaviour.
 *   - LOOKUP_FAILURE_IS_LOUD: a registry read that THROWS is not silently downgraded to k3s — a
 *     dead DB must not quietly resurrect the ENOTFOUND this module removes.
 * Side-effects: IO (PostgreSQL read through the injected lookup).
 * Links: src/ports/node-address.port.ts, src/shared/node-registry/placement.ts,
 *   src/shared/db/nodes.ts (deployment_providers), bug.5106, story.5016
 * @public
 */

import type { Database } from "@cogni/db-client";
import { eq } from "drizzle-orm";

import { NodeAddressError, type NodeAddressPort } from "@/ports";
import { nodes } from "@/shared/db/nodes";
import type { FlightEnv } from "@/shared/node-registry/deploy-hosts";
import {
  type NodeDeploymentPlacement,
  nodeAppBaseUrl,
  providerForEnv,
  toNodeDeploymentPlacement,
} from "@/shared/node-registry/placement";

/**
 * Read one node's declared placement by slug. `null` when the operator has no row for that slug
 * (UNKNOWN_NODE_IS_K3S). Injected so the resolver is unit-testable without a database.
 */
export type NodePlacementLookup = (
  slug: string
) => Promise<NodeDeploymentPlacement | null>;

export interface NodeAddressResolverDeps {
  readonly loadPlacement: NodePlacementLookup;
  /** The operator's OWN deploy env — it dials THIS env's addresses (ENV_SCOPED_VIEW). */
  readonly environment: FlightEnv;
  /** The apex this operator serves (`test.cognidao.org` / `cognidao.org`); undefined in local dev. */
  readonly apexDomain?: string | undefined;
}

export function createNodeAddressResolver(
  deps: NodeAddressResolverDeps
): NodeAddressPort {
  return {
    async resolveNodeAppBaseUrl(slug: string): Promise<string> {
      const placement = await deps.loadPlacement(slug);
      const provider = providerForEnv(placement, deps.environment);
      try {
        return nodeAppBaseUrl({
          slug,
          provider,
          environment: deps.environment,
          apexDomain: deps.apexDomain,
        });
      } catch (err) {
        throw new NodeAddressError(
          `cannot resolve an address for node '${slug}' (deployment_provider=${provider}, env=${deps.environment}): ${String(err)}`,
          slug
        );
      }
    },
  };
}

/** Registry-backed placement lookup — the projection the catalog reconcile job writes. */
export function createDrizzleNodePlacementLookup(
  db: Database
): NodePlacementLookup {
  return async (slug: string) => {
    const rows = await db
      .select({ deploymentProviders: nodes.deploymentProviders })
      .from(nodes)
      .where(eq(nodes.slug, slug))
      .limit(1);
    const row = rows[0];
    return row ? toNodeDeploymentPlacement(row.deploymentProviders) : null;
  };
}
