// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/fleet/fetch-fleet`
 * Purpose: Client-side READ fetchers for the dashboard Fleet/Infra view (story.5013 v0) — the
 *   compute balances and the viewer's own nodes + their per-env deploy state.
 * Scope: Browser/session-cookie fetches (the dashboard is an authed user surface). Zod-validates
 *   each route response at the boundary; never branches on a provider. Does NOT render or cache
 *   (caching/refetch lives in the react-query hooks).
 * Invariants: PERSONAL_SCOPE (nodes are the viewer's own — no all-nodes read), GRACEFUL_DEGRADE
 *   (a per-node deploy-state 404/403/503/network becomes a per-node error marker, never a thrown
 *   page-level failure), VALIDATE_AT_BOUNDARY.
 * Side-effects: IO (HTTP fetch)
 * Links: ./fleet-schemas.ts, GET /api/v1/compute/balances, GET /api/v1/nodes,
 *   GET /api/v1/nodes/[id]/deploy-state
 * @public
 */

import {
  type ComputeBalanceVM,
  computeBalancesResponseSchema,
  deployStateResponseSchema,
  type NodeFleetVM,
  nodesListResponseSchema,
} from "./fleet-schemas";

/** Read every configured compute-provider account balance. */
export async function fetchComputeBalances(): Promise<
  readonly ComputeBalanceVM[]
> {
  const res = await fetch("/api/v1/compute/balances");
  if (!res.ok) {
    // 404 = route not deployed yet → empty (graceful). Other codes surface to the error state.
    if (res.status === 404) return [];
    throw new Error(`compute balances: ${res.status}`);
  }
  const parsed = computeBalancesResponseSchema.parse(await res.json());
  return parsed.balances;
}

/** Resolve the viewer's own nodes, then fan out deploy-state per node. */
export async function fetchFleetNodes(): Promise<readonly NodeFleetVM[]> {
  const listRes = await fetch("/api/v1/nodes");
  if (!listRes.ok) {
    if (listRes.status === 404) return [];
    throw new Error(`nodes list: ${listRes.status}`);
  }
  const { nodes } = nodesListResponseSchema.parse(await listRes.json());

  return Promise.all(nodes.map((node) => fetchNodeDeployState(node)));
}

async function fetchNodeDeployState(node: {
  id: string;
  slug: string;
}): Promise<NodeFleetVM> {
  try {
    const res = await fetch(
      `/api/v1/nodes/${encodeURIComponent(node.id)}/deploy-state`
    );
    if (!res.ok) {
      // 404 = node not found / not live anywhere yet; 503 = deploy capability unwired; 403 = no
      // developer grant. All are per-node, recoverable signals — surface as a marker, not a throw.
      return {
        id: node.id,
        slug: node.slug,
        deployState: null,
        error: `deploy-state ${res.status}`,
      };
    }
    const deployState = deployStateResponseSchema.parse(await res.json());
    return { id: node.id, slug: node.slug, deployState, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return { id: node.id, slug: node.slug, deployState: null, error: message };
  }
}
