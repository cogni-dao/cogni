// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/_errors`
 * Purpose: Map a work-item write failure to a coded HTTP response so a client can tell a permanent refusal from a retryable one.
 * Scope: Response shape only for the work-item write routes (POST/PATCH/DELETE); does not decide authorization and does not touch store pooling.
 * Invariants:
 *   - ERRORCODE_IS_THE_CONTRACT: every mapped response carries a stable `errorCode`; callers branch on it, never on the message text.
 *   - PERMANENT_VS_RETRYABLE: author-scoped refusal → 403 `authz_denied`; store unavailability → 503 `work_items_busy` + retry hint.
 *   - DENIED_VS_UNAVAILABLE (task.5286): a node-admin priority refusal is 403 `authz_denied`; an authorization outage is 503 `authz_unavailable` — never conflated.
 *   - CAS_CONFLICT_IS_409: a lost `expectedRevision` compare-and-set → 409 `revision_conflict` carrying `currentRevision`; nothing was written.
 *   - UNRECOGNIZED_STAYS_500: an unmapped error returns null so the route rethrows and the wrapper answers 500 — the catch is never broadened.
 * Side-effects: IO (HTTP response construction, structured log entry)
 * Links: nodes/operator/app/src/app/_facades/work/items.server.ts, nodes/operator/app/src/app/api/v1/vcs/merge/route.ts, bug.5408
 * @internal
 */

import { NextResponse } from "next/server";

import {
  WorkItemAuthorizationError,
  WorkItemAuthzUnavailableError,
  WorkItemNotFoundError,
  WorkItemRevisionConflictError,
  WorkItemsBackendNotReadyError,
  WorkItemsBusyError,
} from "@/app/_facades/work/items.server";
import {
  logRequestError,
  logRequestWarn,
  type RequestContext,
} from "@/shared/observability";

/** Seconds a caller should wait before retrying a `work_items_busy` write. */
const BUSY_RETRY_AFTER_SECONDS = 2;

type Mapped = {
  readonly status: number;
  readonly errorCode: string;
  readonly error: string;
  readonly retryable?: boolean;
  /** Extra machine-readable body fields (e.g. `currentRevision` on a conflict). */
  readonly details?: Readonly<Record<string, unknown>>;
};

/**
 * Classify a work-item write failure. Returns `null` for anything this module
 * does not recognize — the caller MUST rethrow so the route wrapper still
 * produces its generic 500 (bug.5408 fixed the response SHAPE, not the set of
 * handled faults).
 */
function classify(error: unknown): Mapped | null {
  const message = (error as Error)?.message ?? "";

  // PERMANENT. The store's write authority is author-scoped: the same principal
  // retrying the same payload is refused forever. 403 + the `authz_denied`
  // vocabulary already used by POST /api/v1/vcs/merge. The message is NOT
  // echoed — a denial never narrates the row it protected.
  if (error instanceof WorkItemAuthorizationError) {
    return { status: 403, errorCode: "authz_denied", error: "not authorized" };
  }

  // FAIL CLOSED, DISTINCT FROM DENY. The authorization service could not
  // decide a privileged write (priority 0/1); nothing was written.
  if (error instanceof WorkItemAuthzUnavailableError) {
    return {
      status: 503,
      errorCode: "authz_unavailable",
      error: "authorization unavailable",
    };
  }

  // RETRYABLE. Query timeout / destroyed connection / contended Dolt operation
  // branch. The next attempt usually succeeds, so this must never look like the
  // permanent fault above.
  if (error instanceof WorkItemsBusyError) {
    return {
      status: 503,
      errorCode: "work_items_busy",
      error: message || "work-item store is busy; retry shortly",
      retryable: true,
    };
  }

  // Already-distinguished faults, now carrying an errorCode so a caller can
  // branch on `errorCode` ALONE across every work-item write response.
  if (error instanceof WorkItemsBackendNotReadyError) {
    return {
      status: 503,
      errorCode: "work_items_backend_not_ready",
      error: message,
    };
  }
  if (error instanceof WorkItemNotFoundError) {
    return { status: 404, errorCode: "work_item_not_found", error: message };
  }
  // RETRY AFTER RE-READ. The caller's `expectedRevision` lost the
  // compare-and-set; nothing was written. 409 with the row's current revision.
  if (error instanceof WorkItemRevisionConflictError) {
    return {
      status: 409,
      errorCode: "revision_conflict",
      error: message,
      details: {
        expectedRevision: error.expectedRevision,
        currentRevision: error.currentRevision,
      },
    };
  }
  if ((error as Error)?.name === "WorkItemAlreadyExistsError") {
    return { status: 409, errorCode: "work_item_exists", error: message };
  }

  return null;
}

/**
 * Build the coded HTTP response for a work-item write failure, logging the
 * `errorCode` (4xx → warn, 5xx → error) with the request-scoped logger. The
 * wrapper's terminal `request complete` event is untouched.
 *
 * @returns the response, or `null` when the error is unrecognized (rethrow it).
 */
export function workItemsWriteErrorResponse(
  ctx: RequestContext,
  error: unknown
): NextResponse | null {
  const mapped = classify(error);
  if (!mapped) return null;

  if (mapped.status >= 500) {
    logRequestError(ctx.log, error, mapped.errorCode);
  } else {
    logRequestWarn(ctx.log, error, mapped.errorCode);
  }

  return NextResponse.json(
    {
      error: mapped.error,
      errorCode: mapped.errorCode,
      ...(mapped.details ?? {}),
      ...(mapped.retryable === true
        ? { retryable: true, retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS }
        : {}),
    },
    {
      status: mapped.status,
      ...(mapped.retryable === true
        ? { headers: { "Retry-After": String(BUSY_RETRY_AFTER_SECONDS) } }
        : {}),
    }
  );
}
