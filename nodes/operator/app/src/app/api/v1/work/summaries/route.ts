// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/summaries/route`
 * Purpose: HTTP endpoint for one bounded page of projected Work summaries.
 * Scope: Auth-protected GET. Node-local parts are auth, logging and the facade; decode, read, output validation and error mapping are the published `handleWorkSummariesRequest` (node-template task.0055, adopted task.0056).
 * Invariants:
 *   - VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, NODE_STORE_IS_LOCAL.
 *   - CONTRACTS_ARE_TRUTH: input is `workItemSummariesListOperation.input`, which is the published `WorkSummaryQuerySchema`; output always carries `pageInfo` (with `rowsScanned` when the store reports it).
 *   - BOUNDED_PAGE: `limit` defaults to 25 and is rejected above 100 (400); list filters ≤ 50 values, text ≤ 200 chars, cursor ≤ 2048 chars.
 *   - BOUNDED_TEXT_SCAN: a text search scans at most 1000 rows; a capped page may be empty with `hasMore` and an `endCursor` (progress, not the end).
 *   - TYPED_ERRORS: invalid input or cursor → 400; backend unavailable or busy, including held native capacity (`WorkItemsCapacityError`) → 503; client abort → 499; anything else → 500.
 * Side-effects: IO (HTTP response, Doltgres or Markdown read via the facade)
 * Links: task.0056, @cogni/work-items read-handlers (handleWorkBoardRequest / handleWorkSummariesRequest), contracts/work.items.list.v1.contract
 * @public
 */

import { handleWorkSummariesRequest } from "@cogni/work-items";
import { NextResponse } from "next/server";

import { listWorkSummaries } from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/work/summaries — one bounded summary page.
 *
 * Query params (decoded by `parseWorkSummarySearchParams`): types, statuses
 * (comma-separated), text, projectId, projectIds, node (single or
 * comma-separated), labels, labelPrefix, scored, actor, rankMin, rankMax, limit
 * (default 25, max 100), cursor, sortBy, sortDirection. Configured Dolt is
 * authoritative; genuinely unconfigured nodes use Markdown alone.
 */
export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "work.summaries.list",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request) => {
    const startedAt = performance.now();
    const result = await handleWorkSummariesRequest(
      new URL(request.url).searchParams,
      listWorkSummaries,
      { signal: request.signal }
    );
    logEvent(ctx.log, EVENT_NAMES.WORK_ITEMS_LIST_COMPLETE, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      durationMs: performance.now() - startedAt,
      ...result.telemetry,
    });
    return result.body === null
      ? new NextResponse(null, { status: result.status })
      : NextResponse.json(result.body, { status: result.status });
  }
);
