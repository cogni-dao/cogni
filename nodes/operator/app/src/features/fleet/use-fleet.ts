// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/fleet/use-fleet`
 * Purpose: React Query hooks for the dashboard Fleet/Infra view (story.5013 v0) — compute balances
 *   and the viewer's own nodes + deploy state.
 * Scope: Thin react-query wrappers over the fetchers; owns polling cadence + stale/gc windows. No
 *   rendering, no validation (validation lives in the fetchers).
 * Invariants: ON_DEMAND_READ (poll, never a metric/gauge emit), PERSONAL_SCOPE.
 * Side-effects: IO (via React Query)
 * Links: ./fetch-fleet.ts
 * @public
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { fetchComputeBalances, fetchFleetNodes } from "./fetch-fleet";
import type { ComputeBalanceVM, NodeFleetVM } from "./fleet-schemas";

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

export function useFleetNodes(): UseQueryResult<readonly NodeFleetVM[]> {
  return useQuery({
    queryKey: ["fleet-nodes"],
    queryFn: fetchFleetNodes,
    refetchInterval: 30_000,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
  });
}
