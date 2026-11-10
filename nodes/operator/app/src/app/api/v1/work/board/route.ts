// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/board/route`
 * Purpose: HTTP endpoint for the work board's first page of every visible status column.
 * Scope: Auth-protected GET. Node-local parts are auth, logging and the facade; decode, the budgeted column reads, output validation and error mapping are the published `handleWorkBoardRequest` (work-items 0.7.0, task.0056).
 * Invariants:
 *   - VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, NODE_STORE_IS_LOCAL.
 *   - BOUNDED_BOARD: at most `WORK_BOARD_COLUMN_PAGE` (20) rows per requested status. Without text, all columns are ONE native read (`listWorkBoardColumns`); with text, columns are read sequentially under ONE admission deadline and ONE text-scan budget, and unreached columns return `state: "not_started"`. Each column cursor continues through `/api/v1/work/summaries`.
 *   - ABORT_WITH_REQUEST: `request.signal` stops the board before its next column read (499).
 *   - TYPED_ERRORS: invalid input or cursor → 400; backend unavailable or busy → 503; anything else → 500.
 * Observability: the completion event carries `durationMs`, `columnCount`, `queryCount`, `readMode`, `notStartedCount`, `columnDurationsMs` and `rowsScanned`.
 * Side-effects: IO (HTTP response, Doltgres read via the facade)
 * Links: task.0056, @cogni/work-items read-handlers, ../summaries/route.ts
 * @public
 */

import { handleWorkBoardRequest } from "@cogni/work-items";
import { NextResponse } from "next/server";

import {
  listWorkBoardColumns,
  listWorkSummaries,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/work/board — first page of each visible board column.
 *
 * Query params: the `/api/v1/work/summaries` filters plus a required `statuses`
 * list naming the visible columns. Each column returns up to 20 rows and its own
 * `pageInfo.endCursor`, valid for `/api/v1/work/summaries?statuses=<status>&...`.
 */
export const GET = wrapRouteHandlerWithLogging(
  { routeId: "work.board.list", auth: { mode: "required", getSessionUser } },
  async (ctx, request) => {
    const startedAt = performance.now();
    const result = await handleWorkBoardRequest(
      new URL(request.url).searchParams,
      listWorkSummaries,
      { signal: request.signal, listColumns: listWorkBoardColumns }
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
