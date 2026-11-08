// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/metrics/[id]`
 * Purpose: Read one metric definition with its latest observation and history.
 * Scope: Auth + delegation to the goal-metrics facade; contracts come from @cogni-dao/metrics.
 * Invariants: AUTH_VIA_GETSESSIONUSER (bearer agent key or session cookie); responses are no-store.
 * Side-effects: IO (metric service reads/writes)
 * Links: app/_facades/metrics/goal-metrics.server.ts, story.0021
 * @public
 */

import { NextResponse } from "next/server";
import {
  metricHttpError,
  metricRead,
} from "@/app/_facades/metrics/goal-metrics.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "metrics.metricRead", auth: { mode: "required", getSessionUser } },
  async (_ctx, _request, user, context) => {
    if (!user)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    try {
      if (!context) throw new Error("route_context_missing");
      const { id } = await context.params;
      const response = await metricRead(id);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      return metricHttpError(error);
    }
  }
);
