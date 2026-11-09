// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/metrics/[id]/compute`
 * Purpose: Compute one metric live (POST), recording an immutable observation.
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

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "metrics.metricCompute",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, user, context) => {
    if (!user)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    try {
      if (!context) throw new Error("route_context_missing");
      const { id } = await context.params;
      return metricResponse(
        await metricHandlers().compute(id, () => request.json())
      );
    } catch (error) {
      return metricHttpError(error);
    }
  }
);
