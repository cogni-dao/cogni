// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/fetchContribution`
 * Purpose: Client-side fetch wrapper for a single contribution record (the permalink page).
 * Scope: Calls GET /api/v1/knowledge/contributions/[id] with same-origin credentials.
 * Invariants: Cookie-session only — never sends a Bearer header.
 * Side-effects: IO
 * @internal
 */

import type { ContributionRecord } from "@cogni/node-contracts";

export async function fetchContribution(
  id: string
): Promise<ContributionRecord> {
  const response = await fetch(
    `/api/v1/knowledge/contributions/${encodeURIComponent(id)}`,
    {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    }
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch contribution",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<ContributionRecord>;
}
