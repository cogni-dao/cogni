// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/_errors`
 * Purpose: Map a work-item write failure to a coded HTTP response so a client can tell a permanent refusal from a retryable one.
 * Scope: Response shape only for the work-item write routes (POST/PATCH/DELETE); does not decide authorization and does not touch store pooling.
 * Invariants:
 *   - ERRORCODE_IS_THE_CONTRACT: every mapped response carries a stable `errorCode`; callers branch on it, never on the message text.
 *   - PERMANENT_VS_RETRYABLE: author-scoped refusal → 403 `authz_denied`; store unavailability → 503 `work_items_busy` + retry hint.
 *   - SCORES_INVALID_IS_400: a `scores` write the package validator (`parseWorkItemScores`, run once by the adapter) rejected → 400 `work_item_scores_invalid` carrying its `issues`; nothing was written (story.5111).
 *   - REASON_AND_CITES_ARE_CODED (task.0086): a missing or over-cap reason → 400 `reason_invalid`; broken cite rules → 400 `cites_invalid`; an unknown cite id or closed inbox → 400 `cite_unresolved` with the `ids`; cites with no resolver wired → 400 `cites_unsupported`; a resolver failure → 503 `cite_resolver_unavailable`. Nothing is written in each case.
 *   - MOVES_ARE_CODED (story.0033): an unknown or deprecated metric id is 400 `cite_unresolved` with an issue at `moves` (the same code a cite uses, the issue path tells which field); a bad `moves` list → 400 `moves_invalid`; a non-empty list with no metric wiring → 400 `moves_unsupported`; a baseline read failure → 503 `metric_baseline_unavailable`. Nothing is written in each case. The issue path is `set.moves` on a patch and `moves` on a create.
 *   - CAS_CONFLICT_IS_409: a lost `expectedRevision` compare-and-set → 409 `revision_conflict` carrying `currentRevision`; nothing was written.
 *   - GATES_ARE_CODED (task.0122): a status move the ladder refuses → 409 `gate_unmet` carrying `from`, `to` and `missing`, nothing written; a gate fact (PR, inbox, children) that could not be read → 503 `gate_facts_unavailable`, retry. Both come from the package store, by error name.
 *   - ONE_REFUSAL_EVENT (task.0122): a refused create or patch ends in one registered terminal event (`work.items.create_refused` / `work.items.patch_refused`) with its `errorCode`, status and, for a gate, the stage move; codes and ids only, never a body.
 *   - UNRECOGNIZED_STAYS_500: an unmapped error returns null so the route rethrows and the wrapper answers 500 — the catch is never broadened.
 * Side-effects: IO (HTTP response construction, structured log entry)
 * Links: nodes/operator/app/src/app/_facades/work/items.server.ts, nodes/operator/app/src/app/api/v1/vcs/merge/route.ts, bug.5408
 * @internal
 */

import { EVENT_NAMES } from "@cogni/node-shared";
import { NextResponse } from "next/server";

import {
  ChangeReasonInvalidError,
  CitesInvalidError,
  CitesUnsupportedError,
  EntryResolverUnavailableError,
  EntryUnresolvedError,
  MetricBaselineUnavailableError,
  MovesInvalidError,
  MovesUnsupportedError,
  WorkItemAuthorizationError,
  WorkItemDeletionRetiredError,
  WorkItemNotFoundError,
  WorkItemRevisionConflictError,
  WorkItemScoresInvalidError,
  WorkItemsBackendNotReadyError,
  WorkItemsBusyError,
  WorkItemWriteOutcomeUnknownError,
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
  readonly lookup?: Readonly<Record<string, string | null>>;
  /** Extra machine-readable body fields (e.g. `currentRevision` on a conflict). */
  readonly details?: Readonly<Record<string, unknown>>;
};

/**
 * Classify a work-item write failure. Returns `null` for anything this module
 * does not recognize — the caller MUST rethrow so the route wrapper still
 * produces its generic 500 (bug.5408 fixed the response SHAPE, not the set of
 * handled faults).
 */
function classify(error: unknown, movesPath: readonly string[]): Mapped | null {
  const message = (error as Error)?.message ?? "";

  // PERMANENT. The store's write authority is author-scoped: the same principal
  // retrying the same payload is refused forever. 403 + the `authz_denied`
  // vocabulary already used by POST /api/v1/vcs/merge. The message is NOT
  // echoed — a denial never narrates the row it protected.
  if (error instanceof WorkItemAuthorizationError) {
    return { status: 403, errorCode: "authz_denied", error: "not authorized" };
  }

  // PERMANENT, CALLER'S ERROR (story.5111). SCORES_ONE_ENFORCER: the adapter's
  // `parseWorkItemScores` is the only bounds check and refused before any SQL;
  // the issues name each failed axis path. Never a 500.
  if (error instanceof WorkItemScoresInvalidError) {
    return {
      status: 400,
      errorCode: error.code,
      error: "invalid input",
      details: { issues: error.issues },
    };
  }

  // PERMANENT, CALLER'S ERROR (task.0086). The adapter is the one enforcer of the
  // reason and cite rules and refused before any lock; each issue names its path.
  if (error instanceof ChangeReasonInvalidError) {
    return {
      status: 400,
      errorCode: error.code,
      error: "invalid input",
      details: {
        issues: [{ code: "custom", path: ["reason"], message }],
      },
    };
  }
  if (error instanceof CitesInvalidError) {
    return {
      status: 400,
      errorCode: error.code,
      error: "invalid input",
      details: {
        issues: error.issues.map((issue) => ({
          code: "custom",
          path: ["cites"],
          message: issue,
        })),
      },
    };
  }
  if (error instanceof EntryUnresolvedError) {
    const moves = error.field === "moves";
    return {
      status: 400,
      errorCode: error.code,
      error: "invalid input",
      details: {
        ids: error.ids,
        issues: error.ids.map((cited) => ({
          code: "custom",
          path: moves ? movesPath : ["cites"],
          message: moves
            ? `metric not found or deprecated: ${cited}`
            : `cited entry not found: ${cited}`,
        })),
      },
    };
  }
  if (error instanceof MovesInvalidError) {
    return {
      status: 400,
      errorCode: error.code,
      error: "invalid input",
      details: {
        issues: error.issues.map((issue) => ({
          code: "custom",
          path: movesPath,
          message: issue,
        })),
      },
    };
  }
  if (error instanceof MovesUnsupportedError) {
    return {
      status: 400,
      errorCode: error.code,
      error: "invalid input",
      details: {
        issues: [{ code: "custom", path: movesPath, message }],
      },
    };
  }
  // The baseline reader failed or ran past its deadline; nothing was written.
  if (error instanceof MetricBaselineUnavailableError) {
    return {
      status: 503,
      errorCode: error.code,
      error: message || "metric baseline unavailable",
    };
  }
  if (error instanceof CitesUnsupportedError) {
    return {
      status: 400,
      errorCode: error.code,
      error: "invalid input",
      details: {
        issues: [{ code: "custom", path: ["cites"], message }],
      },
    };
  }
  // The resolver failed or ran past its deadline; nothing was written.
  if (error instanceof EntryResolverUnavailableError) {
    return {
      status: 503,
      errorCode: error.code,
      error: message || "cite resolver unavailable",
    };
  }

  if (error instanceof WorkItemDeletionRetiredError) {
    return {
      status: 410,
      errorCode: "work_item_deletion_retired",
      error:
        message ||
        "Work-item hard deletion is retired; PATCH status=cancelled to preserve identity and provenance",
    };
  }

  if (error instanceof WorkItemWriteOutcomeUnknownError)
    return {
      status: 409,
      errorCode: error.code,
      error: error.message,
      retryable: false,
      lookup: error.receipt.lookup,
    };

  // A gate refusal (task.0122): the package store refused the move before any write. Matched by name, like
  // the package's own `workItemWriteErrorResponse`, so this module needs no class import from the facade.
  const gate = error as {
    name?: string;
    from?: unknown;
    to?: unknown;
    missing?: unknown;
  };
  if (
    gate?.name === "WorkItemGateUnmetError" ||
    gate?.name === "WorkItemGateFactsUnavailableError"
  ) {
    const unmet = gate.name === "WorkItemGateUnmetError";
    return {
      status: unmet ? 409 : 503,
      errorCode: unmet ? "gate_unmet" : "gate_facts_unavailable",
      error: message,
      details: {
        from: gate.from ?? null,
        to: gate.to ?? null,
        missing: gate.missing ?? null,
        message,
      },
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
 * `movesPath` is the request path to `moves` (`["set", "moves"]` on a patch, the default;
 * `["moves"]` on a create): a `moves` issue names that path.
 *
 * @returns the response, or `null` when the error is unrecognized (rethrow it).
 */
export function workItemsWriteErrorResponse(
  ctx: RequestContext,
  error: unknown,
  movesPath: readonly string[] = ["set", "moves"]
): NextResponse | null {
  const mapped = classify(error, movesPath);
  if (!mapped) return null;

  // ONE_REFUSAL_EVENT: a refused create or patch is one registered terminal event; the delete route keeps the wrapper's line.
  const refusedEvent =
    ctx.routeId === "work.items.create"
      ? EVENT_NAMES.WORK_ITEMS_CREATE_REFUSED
      : ctx.routeId === "work.items.patch"
        ? EVENT_NAMES.WORK_ITEMS_PATCH_REFUSED
        : null;
  if (refusedEvent) {
    const { from, to, missing } = (mapped.details ?? {}) as Record<
      string,
      unknown
    >;
    ctx.log.info(
      {
        event: refusedEvent,
        routeId: ctx.routeId,
        outcome: "refused",
        status: mapped.status,
        errorCode: mapped.errorCode,
        ...(typeof from === "string" ? { from } : {}),
        ...(typeof to === "string" ? { to } : {}),
        ...(typeof missing === "string" ? { missing } : {}),
      },
      refusedEvent
    );
  }

  if (mapped.status >= 500) {
    logRequestError(ctx.log, error, mapped.errorCode);
  } else {
    logRequestWarn(ctx.log, error, mapped.errorCode);
  }

  return NextResponse.json(
    {
      error: mapped.error,
      errorCode: mapped.errorCode,
      ...(mapped.retryable === false
        ? { retryable: false, lookup: mapped.lookup }
        : {}),
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
