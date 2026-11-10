// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/metrics/metrics`
 * Purpose: List metric definitions with their latest attempt (cursor-paged).
 * Scope: Auth and logging here; parsing, contract validation and error mapping are the published `@cogni-dao/metrics/http` handler, bound in the metrics facade.
 * Invariants: AUTH_VIA_GETSESSIONUSER (bearer agent key or session cookie); responses are no-store.
 * Side-effects: IO (metric service reads/writes)
 * Links: app/_facades/metrics.server.ts, story.0021
 * @public
 */

import { NextResponse } from "next/server";
import {
  metricHandlers,
  metricHttpError,
  metricResponse,
} from "@/app/_facades/metrics.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "metrics.metricList", auth: { mode: "required", getSessionUser } },
  async (_ctx, request, user) => {
    if (!user)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    try {
      return metricResponse(
        await metricHandlers().list(new URL(request.url).searchParams)
      );
    } catch (error) {
      return metricHttpError(error);
    }
  }
);
