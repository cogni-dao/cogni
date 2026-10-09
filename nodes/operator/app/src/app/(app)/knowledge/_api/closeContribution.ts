// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/closeContribution`
 * Purpose: Client-side POST to reject (close) a contribution branch without merging.
 * Scope: Cookie-session only — server-side authSource() checks for Bearer header and rejects.
 * Side-effects: IO; flips knowledge_<node> contribution state to `closed` and deletes its branch.
 * @internal
 */

import { fetchContribution } from "./fetchContribution";

export interface CloseResult {
  contributionId: string;
  closed: true;
}

const MAX_TRANSIENT_ATTEMPTS = 4;

function retryDelayMs(response: Response): number {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 2_000;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function closeContribution(
  contributionId: string,
  reason: string
): Promise<CloseResult> {
  for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
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
    if (response.ok) {
      return response.json() as Promise<CloseResult>;
    }

    const error = await response.json().catch(() => ({
      error: "Failed to reject contribution",
      retryable: false,
    }));
    // The write can commit durably before its HTTP acknowledgement is lost.
    // Reconcile the authoritative state before telling the admin to retry an
    // already-completed close.
    const current = await fetchContribution(contributionId).catch(() => null);
    if (current?.state === "closed") {
      return { contributionId, closed: true };
    }

    // Admission failures happen before mutation and are explicitly replayable.
    // Keep the button pending and retry for the admin; requiring manual clicks
    // made a healthy eventual close look like repeated corruption.
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

  throw new Error("Failed to reject contribution");
}
