// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/mergeContribution`
 * Purpose: Client-side POST to merge a contribution branch into main.
 * Scope: Cookie-session only — server-side authSource() checks for Bearer header and rejects.
 * Side-effects: IO; mutates Doltgres knowledge_<node> main branch.
 * @internal
 */

import { fetchContribution } from "./fetchContribution";

export interface MergeResult {
  contributionId: string;
  commitHash: string;
}

const MAX_TRANSIENT_ATTEMPTS = 4;

function retryDelayMs(response: Response): number {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 2_000;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function mergeContribution(
  contributionId: string
): Promise<MergeResult> {
  for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
    const response = await fetch(
      `/api/v1/knowledge/contributions/${encodeURIComponent(contributionId)}/merge`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: "{}",
      }
    );
    if (response.ok) {
      return response.json() as Promise<MergeResult>;
    }

    const error = await response.json().catch(() => ({
      error: "Failed to merge contribution",
      retryable: false,
    }));
    // A merge may be durable even when the response is lost during branch
    // cleanup. Read main before presenting an ambiguous failure or inviting a
    // duplicate retry.
    const current = await fetchContribution(contributionId).catch(() => null);
    if (current?.state === "merged" && current.mergedCommit) {
      return { contributionId, commitHash: current.mergedCommit };
    }

    if (
      response.status === 503 &&
      error.retryable === true &&
      attempt < MAX_TRANSIENT_ATTEMPTS
    ) {
      await wait(retryDelayMs(response));
      continue;
    }
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  throw new Error("Failed to merge contribution");
}
