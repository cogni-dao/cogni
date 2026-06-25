// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/fleet/fetch-fleet`
 * Purpose: Client-side READ fetcher for the dashboard Fleet/Infra SERVERS sub-card (story.5013 v0) —
 *   the compute-provider balances. (The NODES table is server-rendered from the node registry, so it
 *   has no client fetcher — see FleetInfraCard / the dashboard server page.tsx.)
 * Scope: Browser/session-cookie fetch (the dashboard is an authed user surface). Zod-validates the
 *   route response at the boundary; never branches on a provider. Does NOT render or cache
 *   (caching/refetch lives in the react-query hook).
 * Invariants: GRACEFUL_DEGRADE (a 404 becomes an empty list, never a thrown page-level failure),
 *   VALIDATE_AT_BOUNDARY.
 * Side-effects: IO (HTTP fetch)
 * Links: ./fleet-schemas.ts, GET /api/v1/compute/balances
 * @public
 */

import {
  type ComputeBalanceVM,
  computeBalancesResponseSchema,
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
