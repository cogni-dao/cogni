// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/schedules/readback`
 * Purpose: Bind owned scheduling reads to HTTP errors and metadata events.
 * Scope: Composes local dependencies; does not implement query or executor behavior.
 * Invariants: Typed errors retain identity; unknown errors propagate to the route wrapper.
 * Side-effects: IO
 * Links: https://cognidao.org/work/items/task.5356
 * @internal
 */

import type { EventName } from "@cogni/node-shared";
import {
  InvalidScheduleRunCursorError,
  ScheduleHistoryNotFoundError,
} from "@cogni/scheduling";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { createOwnedScheduleHistory } from "@/features/scheduling/services/history";
import { logEvent, type RequestContext } from "@/shared/observability";

export const scheduleReadHeaders = { "Cache-Control": "no-store, private" };
export function scheduleReadback() {
  return createOwnedScheduleHistory(getContainer());
}
export function scheduleReadError(
  error: unknown,
  ctx: RequestContext,
  event: EventName,
  startedAt: number
) {
  const status =
    error instanceof ScheduleHistoryNotFoundError
      ? 404
      : error instanceof InvalidScheduleRunCursorError
        ? 400
        : 500;
  logEvent(ctx.log, event, {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    status,
    outcome: "error",
    durationMs: performance.now() - startedAt,
    errorCode:
      status === 404
        ? "SCHEDULE_READ_NOT_FOUND"
        : status === 400
          ? "SCHEDULE_CURSOR_INVALID"
          : "SCHEDULE_READ_FAILED",
  });
  if (error instanceof ScheduleHistoryNotFoundError)
    return NextResponse.json(
      { error: "Schedule not found" },
      { status, headers: scheduleReadHeaders }
    );
  if (error instanceof InvalidScheduleRunCursorError)
    return NextResponse.json(
      { error: error.message },
      { status, headers: scheduleReadHeaders }
    );
  throw error;
}
export function invalidScheduleRead(
  ctx: RequestContext,
  event: EventName,
  startedAt: number
) {
  logEvent(ctx.log, event, {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    status: 400,
    outcome: "error",
    errorCode: "SCHEDULE_READ_INVALID",
    durationMs: performance.now() - startedAt,
  });
  return NextResponse.json(
    { error: "Invalid schedule request" },
    { status: 400, headers: scheduleReadHeaders }
  );
}
