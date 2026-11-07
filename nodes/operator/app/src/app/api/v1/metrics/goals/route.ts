// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/metrics/goals`
 * Purpose: Read this node's goals with their KPI cards and hypotheses (the Goals view read model).
 * Scope: Auth + delegation to the goal-metrics facade; contracts come from @cogni-dao/metrics.
 * Invariants: AUTH_VIA_GETSESSIONUSER (bearer agent key or session cookie); responses are no-store.
 * Side-effects: IO (metric service reads/writes)
 * Links: app/_facades/metrics/goal-metrics.server.ts, story.0021
 * @public
 */

import { NextResponse } from "next/server";
import {
  loadGoalsProgress,
  metricHttpError,
} from "@/app/_facades/metrics/goal-metrics.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "metrics.goalsRead", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, user) => {
    if (!user)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    try {
      const data = await loadGoalsProgress();
      // App-local event: ctx.log directly (logEvent types only the shared EventName).
      ctx.log.info(
        {
          event: EVENT_NAMES.GOALS_PROGRESS_READ,
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          goalCount: data.goals.length,
          metricCount: data.goals.reduce((n, g) => n + g.kpis.length, 0),
          hypothesisCount: data.goals.reduce(
            (n, g) => n + g.hypotheses.length,
            0
          ),
          outcome: "success",
        },
        EVENT_NAMES.GOALS_PROGRESS_READ
      );
      return NextResponse.json(data, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return metricHttpError(error);
    }
  }
);
