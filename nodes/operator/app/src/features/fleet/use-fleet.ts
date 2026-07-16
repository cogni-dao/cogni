// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/fleet/use-fleet`
 * Purpose: React Query hook for the dashboard Fleet/Infra SERVERS sub-card (story.5013 v0) — the
 *   compute-provider balances. (The NODES table is server-rendered from the node registry; it has no
 *   client hook.)
 * Scope: Thin react-query wrapper over the fetcher; owns polling cadence + stale/gc windows. No
 *   rendering, no validation (validation lives in the fetcher).
 * Invariants: ON_DEMAND_READ (poll, never a metric/gauge emit).
 * Side-effects: IO (via React Query)
 * Links: ./fetch-fleet.ts
 * @public
 */

import { type UseQueryResult, useQuery } from "@tanstack/react-query";

import { fetchComputeBalances } from "./fetch-fleet";
import type { ComputeBalanceVM } from "./fleet-schemas";

export function useComputeBalances(): UseQueryResult<
  readonly ComputeBalanceVM[]
> {
  return useQuery({
    queryKey: ["fleet-balances"],
    queryFn: fetchComputeBalances,
    refetchInterval: 60_000,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });
}
