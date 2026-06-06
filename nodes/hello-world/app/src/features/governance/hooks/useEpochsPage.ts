// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/hooks/useEpochsPage`
 * Purpose: Unified React Query hook for the epoch page — current epoch + past epochs in one query.
 * Scope: Client-side data fetching. Single list-epochs call, partitions into current (open/review) vs past (review/finalized). Uses appropriate compose function per status. Does not access database directly.
 * Invariants: Typed with view model types from types.ts. Prefers open epoch as current, falls back to review.
 * Side-effects: IO (HTTP GET to ledger API endpoints)
 * Links: src/features/governance/types.ts, src/features/governance/lib/compose-epoch.ts
 * @public
 */

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import pLimit from "p-limit";
import type {
  ApiIngestionReceipt,
  EpochClaimantsDto,
  EpochDto,
  UserProjectionDto,
} from "@/features/governance/lib/compose-epoch";
import {
  composeEpochView,
  composeEpochViewFromClaimants,
} from "@/features/governance/lib/compose-epoch";
import type { EpochView } from "@/features/governance/types";

export interface EpochsPageData {
  readonly current: EpochView | null;
  readonly pastEpochs: readonly EpochView[];
}

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

/** Compose an open/review epoch using user-projections (live data). */
async function composeCurrentEpoch(epoch: EpochDto): Promise<EpochView> {
  const [userProjectionsRes, activityRes] = await Promise.all([
    fetchJson<{ userProjections: UserProjectionDto[] }>(
      `/api/v1/attribution/epochs/${epoch.id}/user-projections`
    ),
    fetchJson<{ events: ApiIngestionReceipt[] }>(
      `/api/v1/attribution/epochs/${epoch.id}/activity?limit=200`
    ),
  ]);
  return composeEpochView(
    epoch,
    userProjectionsRes.userProjections,
    activityRes.events
  );
}

/** Compose a finalized epoch using claimant-based attribution (frozen data). */
async function composePastEpoch(epoch: EpochDto): Promise<EpochView> {
  if (epoch.status === "finalized") {
    const [claimantsRes, activityRes] = await Promise.all([
      fetchJson<EpochClaimantsDto>(
        `/api/v1/attribution/epochs/${epoch.id}/claimants`
      ),
      fetchJson<{ events: ApiIngestionReceipt[] }>(
        `/api/v1/attribution/epochs/${epoch.id}/activity?limit=200`
      ),
    ]);
    return composeEpochViewFromClaimants(
      epoch,
      claimantsRes,
      activityRes.events
    );
  }
  // Review epochs that aren't the current one — use user-projections
  return composeCurrentEpoch(epoch);
}

async function fetchEpochsPage(): Promise<EpochsPageData> {
  const { epochs } = await fetchJson<{ epochs: EpochDto[] }>(
    "/api/v1/attribution/epochs?limit=200"
  );

  // Find the current epoch: prefer open, fall back to most recent review
  const current =
    epochs.find((e) => e.status === "open") ??
    epochs.find((e) => e.status === "review") ??
    null;

  // Past = everything except the current epoch, sorted newest-first by periodEnd
  const past = epochs
    .filter((e) => e !== current && e.status !== "open")
    .sort(
      (a, b) =>
        new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime()
    );

  const [currentView, pastViews] = await Promise.all([
    current ? composeCurrentEpoch(current) : null,
    Promise.all(past.map((epoch) => limit(() => composePastEpoch(epoch)))),
  ]);

  return { current: currentView, pastEpochs: pastViews };
}

export function useEpochsPage(): UseQueryResult<EpochsPageData, Error> {
  return useQuery({
    queryKey: ["governance", "epochs", "page"],
    queryFn: fetchEpochsPage,
    staleTime: 60_000,
  });
}
