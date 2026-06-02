// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/fetchContributions`
 * Purpose: Client-side fetch wrapper for the contributions inbox.
 * Scope: Calls GET /api/v1/knowledge/contributions?state=open with cookie credentials.
 * Invariants: Cookie-session only.
 * Side-effects: IO
 * @internal
 */

import type { ContributionRecord } from "@cogni/node-contracts";

export interface ContributionsListResponse {
  contributions: ContributionRecord[];
}

export async function fetchContributions(
  state: "open" | "merged" | "closed" | "all" = "open"
): Promise<ContributionsListResponse> {
  const response = await fetch(
    `/api/v1/knowledge/contributions?state=${state}&limit=100`,
    {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    }
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch contributions",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<ContributionsListResponse>;
}
