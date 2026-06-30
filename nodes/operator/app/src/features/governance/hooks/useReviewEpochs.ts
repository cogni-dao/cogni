// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/hooks/useReviewEpochs`
 * Purpose: React Query hook for epochs in review status (admin review page).
 * Scope: Client-side data fetching for /gov/review page. Reuses compose-epoch composition layer. Does not access database directly.
 * Invariants: Typed with view model types from types.ts.
 * Side-effects: IO (HTTP GET to ledger API endpoints)
 * Links: src/features/governance/types.ts, src/features/governance/lib/compose-epoch.ts
 * @public
 */

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type {
  ApiIngestionReceipt,
  EpochDto,
} from "@/features/governance/lib/compose-epoch";
import { composeEpochView } from "@/features/governance/lib/compose-epoch";
import type { EpochView } from "@/features/governance/types";

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

async function fetchReviewEpochs(): Promise<readonly EpochView[]> {
  const { epochs } = await fetchJson<{ epochs: EpochDto[] }>(
    "/api/v1/attribution/epochs?limit=200"
  );
  const reviewRaw = epochs.filter((e) => e.status === "review");
  if (reviewRaw.length === 0) return [];

  // ONE_SSOT: review-epoch view derives entirely from /activity (selection +
  // weightConfig) — no user-projections fetch (that path double-counted users).
  return Promise.all(
    reviewRaw.map(async (epoch) => {
      const activityRes = await fetchJson<{ events: ApiIngestionReceipt[] }>(
        `/api/v1/attribution/epochs/${epoch.id}/activity?limit=200`
      );
      return composeEpochView(epoch, activityRes.events);
    })
  );
}

export function useReviewEpochs(): UseQueryResult<readonly EpochView[], Error> {
  return useQuery({
    queryKey: ["governance", "epochs", "review"],
    queryFn: fetchReviewEpochs,
    staleTime: 30_000,
  });
}
