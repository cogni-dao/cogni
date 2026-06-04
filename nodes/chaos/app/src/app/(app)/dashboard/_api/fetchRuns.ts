// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/_api/fetchRuns`
 * Purpose: Client-side fetch for graph run list. Calls GET /api/v1/ai/runs; returns empty on 404/network error (API not deployed), throws on other failures.
 * Scope: Data fetching only. Does not implement business logic.
 * Invariants: Returns RunCardData[] matching the RunCard component props.
 * Side-effects: IO (HTTP fetch)
 * Links: [RunCard](../../../../components/kit/data-display/RunCard.tsx)
 * @public
 */

import type { RunCardData } from "@/components/kit/data-display/RunCard";

interface FetchRunsParams {
  tab: "user" | "system";
  limit?: number;
}

interface FetchRunsResponse {
  runs: RunCardData[];
}

/**
 * Fetch graph runs for the dashboard.
 * TODO(task.0183): Replace with real API call to GET /api/v1/ai/runs once implemented.
 */
export async function fetchRuns(
  params: FetchRunsParams
): Promise<FetchRunsResponse> {
  const searchParams = new URLSearchParams();
  if (params.tab === "system") {
    searchParams.set("scope", "system");
  }
  if (params.limit) {
    searchParams.set("limit", String(params.limit));
  }

  // Attempt real API — gracefully degrade to empty only if endpoint doesn't exist yet
  try {
    const res = await fetch(`/api/v1/ai/runs?${searchParams.toString()}`);
    if (res.ok) {
      return res.json() as Promise<FetchRunsResponse>;
    }
    // 404 = API not deployed yet — return empty. Other errors should surface.
    if (res.status === 404) {
      return { runs: [] };
    }
    throw new Error(`Failed to fetch runs: ${res.status} ${res.statusText}`);
  } catch (err) {
    // Network error (fetch itself failed) = API not available
    if (err instanceof TypeError) {
      return { runs: [] };
    }
    throw err;
  }
}
