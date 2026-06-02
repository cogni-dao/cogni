// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/treasury/hooks/useTreasurySnapshot`
 * Purpose: React Query hook for treasury snapshot with no client-side polling.
 * Scope: Client-side only. Calls /api/v1/treasury/snapshot once per page load with long staleTime. Does not call RPC directly.
 * Invariants: NO refetchInterval, NO refetchOnWindowFocus; rely on staleTime only.
 * Side-effects: IO (HTTP GET to treasury snapshot API)
 * Notes: Phase 2: USDC balance only. Returns full snapshot (address, chainId, balance, staleWarning).
 * Links: docs/spec/onchain-readers.md
 * @public
 */

"use client";

import type { TreasurySnapshotResponseV1 } from "@cogni/node-contracts";
import { useQuery } from "@tanstack/react-query";

const TREASURY_STALE_TIME_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Fetches treasury snapshot from API.
 * No authentication required (public data).
 */
async function fetchTreasurySnapshot(): Promise<TreasurySnapshotResponseV1> {
  const res = await fetch("/api/v1/public/treasury/snapshot");

  if (!res.ok) {
    throw new Error(`Treasury snapshot fetch failed: ${res.status}`);
  }

  return res.json();
}

export interface UseTreasurySnapshotResult {
  /** USDC balance formatted as decimal string (e.g., "3726.42") */
  usdcBalance: string | null;
  /** Treasury address from API response */
  treasuryAddress: string | null;
  /** Chain ID from API response */
  chainId: number | null;
  /** Whether data is currently loading */
  isLoading: boolean;
  /** Error if fetch failed */
  error: Error | null;
  /** Warning flag indicating stale/unavailable RPC data */
  staleWarning: boolean;
}

/**
 * Hook for treasury snapshot display.
 * Calls API once per page load; no client-side polling.
 *
 * @returns Treasury snapshot with address, chainId, balance, loading/error/staleWarning flags
 */
export function useTreasurySnapshot(): UseTreasurySnapshotResult {
  const { data, isLoading, error } = useQuery({
    queryKey: ["treasury", "snapshot"],
    queryFn: fetchTreasurySnapshot,
    staleTime: TREASURY_STALE_TIME_MS, // Data stays fresh for 2 minutes
    refetchInterval: false, // NO polling
    refetchOnWindowFocus: false, // NO refetch on window focus
    retry: 1, // Retry once on failure
  });

  // Extract USDC balance from first balance entry
  const usdcBalance =
    data?.balances && data.balances.length > 0
      ? (data.balances[0]?.balanceFormatted ?? null)
      : null;

  return {
    usdcBalance,
    treasuryAddress: data?.treasuryAddress ?? null,
    chainId: data?.chainId ?? null,
    isLoading,
    error: error as Error | null,
    staleWarning: data?.staleWarning ?? false,
  };
}
