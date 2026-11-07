// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/metrics`
 * Purpose: List metric definitions with their latest attempt (cursor-paged).
 * Scope: Auth + delegation to the goal-metrics facade; contracts come from @cogni-dao/metrics.
 * Invariants: AUTH_VIA_GETSESSIONUSER (bearer agent key or session cookie); responses are no-store.
 * Side-effects: IO (metric service reads/writes)
 * Links: app/_facades/metrics/goal-metrics.server.ts, story.0021
 * @public
 */

import { MetricListInputSchema } from "@cogni-dao/metrics/contracts";
import { NextResponse } from "next/server";
import {
  metricHttpError,
  metricList,
} from "@/app/_facades/metrics/goal-metrics.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "metrics.metricList", auth: { mode: "required", getSessionUser } },
  async (_ctx, request, user) => {
    if (!user)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const query = new URL(request.url).searchParams;
    const input = MetricListInputSchema.safeParse({
      ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}),
      ...(query.has("after") ? { after: query.get("after") } : {}),
    });
    if (!input.success)
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    try {
      const response = await metricList(input.data);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      return metricHttpError(error);
    }
  }
);
