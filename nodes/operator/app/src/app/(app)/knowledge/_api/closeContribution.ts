// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/closeContribution`
 * Purpose: Client-side POST to reject (close) a contribution branch without merging.
 * Scope: Same-origin session UI; the service retains author-or-session authority.
 * Invariants: Guarded review calls verify closed state after every POST attempt;
 *   uncertain outcomes stop the batch, and omitted options preserve legacy callers.
 * Side-effects: IO; flips knowledge_<node> contribution state to `closed` and deletes its branch.
 * @internal
 */

import { ContributionReadError, fetchContribution } from "./fetchContribution";

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
  reason: string,
  review?: { expectedHeadCommit: string | null; stillActive?: () => boolean }
): Promise<CloseResult> {
  if (review)
    return closeReviewedContribution(
      contributionId,
      reason,
      review.expectedHeadCommit,
      review.stillActive ?? (() => true)
    );
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

/** Structured guarded-call failures retain the server/transport recovery boundary. */
export class ReviewedCloseError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
    readonly stopBatch: boolean
  ) {
    super(message);
    this.name = "ReviewedCloseError";
  }
}

async function closeReviewedContribution(
  contributionId: string,
  reason: string,
  expectedHeadCommit: string | null,
  stillActive: () => boolean
): Promise<CloseResult> {
  for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
    // Check again after any retry delay. Unmount never cancels native settlement,
    // but it must prevent dispatch of another HTTP attempt for an old review.
    if (!stillActive()) {
      throw new ReviewedCloseError(
        "Review closed; no further close was sent.",
        null,
        "close_cancelled",
        true
      );
    }
    let response: Response | undefined;
    let failure: { error?: string; errorCode?: string; retryable?: boolean } =
      {};
    try {
      response = await fetch(
        `/api/v1/knowledge/contributions/${encodeURIComponent(contributionId)}/close`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({ reason, expectedHeadCommit }),
        }
      );
      if (!response.ok) failure = await response.json().catch(() => ({}));
    } catch {
      // A timeout ends this caller's wait, not the native owner's operation.
    }

    // Every POST attempt, including 2xx and transport failures, is reconciled.
    const { record: current, status: readbackStatus } = await fetchContribution(
      contributionId,
      AbortSignal.timeout(10_000)
    ).then(
      (record) => ({ record, status: 200 }),
      (error: unknown) => ({
        record: null,
        status: error instanceof ContributionReadError ? error.status : null,
      })
    );
    if (current?.state === "closed") return { contributionId, closed: true };
    if (response?.status === 404 && readbackStatus === 404) {
      throw new ReviewedCloseError(
        "Proposal no longer exists; skipped.",
        404,
        "not_found",
        false
      );
    }
    if (!current) {
      throw new ReviewedCloseError(
        "Could not verify the close. Reload before trying again.",
        response?.status ?? null,
        "close_unverified",
        true
      );
    }
    if (response?.status === 503 && failure.retryable === true) {
      if (attempt < MAX_TRANSIENT_ATTEMPTS) {
        await wait(Math.min(10_000, Math.max(1_000, retryDelayMs(response))));
        continue;
      }
      throw new ReviewedCloseError(
        "Knowledge writer is busy. Reload and retry.",
        503,
        "knowledge_busy",
        true
      );
    }
    if (response && !response.ok && response.status < 500) {
      const uncertain =
        response.status === 409 &&
        failure.errorCode !== "contribution_head_changed";
      throw new ReviewedCloseError(
        failure.error || `Close refused (HTTP ${response.status}).`,
        response.status,
        failure.errorCode || "close_refused",
        uncertain || response.status === 401
      );
    }
    throw new ReviewedCloseError(
      "Close outcome is unresolved. Reload before trying again.",
      response?.status ?? null,
      failure.errorCode || "close_unverified",
      true
    );
  }
  throw new ReviewedCloseError(
    "Close was not verified.",
    null,
    "close_unverified",
    true
  );
}
