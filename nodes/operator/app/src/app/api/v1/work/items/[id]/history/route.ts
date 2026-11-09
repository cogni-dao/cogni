// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/history`
 * Purpose: GET a work item's versions, newest first, each with its change reason (story.0023).
 * Scope: Thin route: session check, id, `readWorkItemHistory` from `@cogni/work-items`, one log event, response. Holds no history logic.
 * Invariants: NOTE_NOT_BODY, ONE_HISTORY_SHAPE, one terminal log event per read (counts only). The package owns the event name; the node registers none.
 * Side-effects: IO (HTTP response, Doltgres read)
 * Links: hub change-history-design, change-history-fleet-adoption
 * @public
 */

import { readWorkItemHistory } from "@cogni/work-items";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.history", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser, context) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    const startedAt = Date.now();
    const { status, body, log } = await readWorkItemHistory(
      getContainer().doltgresWorkItems,
      id
    );
    const { event, errorName, ...fields } = log;
    ctx.log.info(
      {
        event,
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        ...fields,
        durationMs: Date.now() - startedAt,
      },
      event
    );
    if (errorName !== undefined) {
      ctx.log.warn({ errorName }, "work.items.history_unavailable");
    }
    return NextResponse.json(body, { status });
  }
);
