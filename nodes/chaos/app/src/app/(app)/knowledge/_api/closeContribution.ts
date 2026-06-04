// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/closeContribution`
 * Purpose: Client-side POST to reject (close) a contribution branch without merging.
 * Scope: Cookie-session only — server-side authSource() checks for Bearer header and rejects.
 * Side-effects: IO; flips knowledge_<node> contribution state to `closed` and deletes its branch.
 * @internal
 */

export interface CloseResult {
  contributionId: string;
  closed: true;
}

export async function closeContribution(
  contributionId: string,
  reason: string
): Promise<CloseResult> {
  const response = await fetch(
    `/api/v1/knowledge/contributions/${encodeURIComponent(contributionId)}/close`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ reason }),
    }
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to reject contribution",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<CloseResult>;
}
