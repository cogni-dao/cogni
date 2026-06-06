// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/hooks/useHoldings`
 * Purpose: React Query hook for cumulative credit holdings across finalized epochs.
 * Scope: Client-side data fetching for /gov/holdings page; does not access database directly. Fetches finalized epochs, then for each fetches statement, aggregating into holdings.
 * Invariants: Uses statements as source of truth (frozen, deterministic).
 * Side-effects: IO (HTTP GET to ledger API endpoints)
 * Links: src/features/governance/types.ts, src/features/governance/lib/compose-holdings.ts
 * @public
 */

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import pLimit from "p-limit";

import type {
  EpochClaimantsDto,
  EpochDto,
} from "@/features/governance/lib/compose-epoch";
import { composeHoldings } from "@/features/governance/lib/compose-holdings";
import type { HoldingsData } from "@/features/governance/types";

const limit = pLimit(3);

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function fetchHoldings(): Promise<HoldingsData> {
  const { epochs } = await fetchJson<{ epochs: EpochDto[] }>(
    "/api/v1/attribution/epochs?limit=200"
  );
  const finalized = epochs.filter((e) => e.status === "finalized");

  const claimants = await Promise.all(
    finalized.map((e) =>
      limit(() =>
        fetchJson<EpochClaimantsDto>(
          `/api/v1/attribution/epochs/${e.id}/claimants`
        )
      )
    )
  );

  return composeHoldings(finalized, claimants);
}

export function useHoldings(): UseQueryResult<HoldingsData, Error> {
  return useQuery({
    queryKey: ["governance", "holdings"],
    queryFn: fetchHoldings,
    staleTime: 60_000,
  });
}
