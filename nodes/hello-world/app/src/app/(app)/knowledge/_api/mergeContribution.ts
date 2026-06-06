// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/mergeContribution`
 * Purpose: Client-side POST to merge a contribution branch into main.
 * Scope: Cookie-session only — server-side authSource() checks for Bearer header and rejects.
 * Side-effects: IO; mutates Doltgres knowledge_<node> main branch.
 * @internal
 */

export interface MergeResult {
  contributionId: string;
  commitHash: string;
}

export async function mergeContribution(
  contributionId: string,
  confidencePct?: number
): Promise<MergeResult> {
  const response = await fetch(
    `/api/v1/knowledge/contributions/${encodeURIComponent(contributionId)}/merge`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(confidencePct != null ? { confidencePct } : {}),
    }
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to merge contribution",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<MergeResult>;
}
