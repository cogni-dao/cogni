// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/public/analytics/summary`
 * Purpose: Public HTTP endpoint for analytics summary with privacy guarantees.
 * Scope: Public route using wrapPublicRoute(); validates query params, delegates to facade, returns JSON. Does not perform queries or business logic.
 * Invariants: Fixed windows only (7d/30d/90d); contract-validated output; rate limit + cache via wrapPublicRoute().
 * Side-effects: IO (reads metrics via facade)
 * Notes: wrapPublicRoute() auto-applies rate limiting (10 req/min/IP + burst 5) and cache headers (60s + swr 300s).
 * Links: docs/spec/public-analytics.md, contracts/analytics.summary.v1.contract.ts, bootstrap/http/wrapPublicRoute.ts
 * @public
 */

import { analyticsSummaryOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getAnalyticsSummaryFacade } from "@/app/_facades/analytics/summary.server";
import { wrapPublicRoute } from "@/bootstrap/http";
import { logRequestWarn, type RequestContext } from "@/shared/observability";

export const dynamic = "force-dynamic";

/**
 * Local error handler for analytics summary route.
 * Maps domain errors to HTTP responses; returns null for unhandled errors.
 */
function handleRouteError(
  ctx: RequestContext,
  error: unknown
): NextResponse | null {
  // Zod validation errors
  if (error && typeof error === "object" && "issues" in error) {
    logRequestWarn(ctx.log, error, "VALIDATION_ERROR");
    return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  }

  // Metrics query errors (adapter failures)
  if (
    error instanceof Error &&
    (error.message.includes("Mimir query") || error.message.includes("timeout"))
  ) {
    logRequestWarn(ctx.log, error, "METRICS_QUERY_ERROR");
    return NextResponse.json(
      { error: "Metrics service temporarily unavailable" },
      { status: 503 }
    );
  }

  return null;
}

export const GET = wrapPublicRoute(
  {
    routeId: "analytics.summary",
    cacheTtlSeconds: 60,
    staleWhileRevalidateSeconds: 300,
  },
  async (ctx, request) => {
    try {
      const { searchParams } = new URL(request.url);
      const window = searchParams.get("window") ?? "7d";

      const input = analyticsSummaryOperation.input.parse({ window });

      const summary = await getAnalyticsSummaryFacade({
        window: input.window,
      });

      // Validate output against contract
      const output = analyticsSummaryOperation.output.parse(summary);

      return NextResponse.json(output);
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error; // Unhandled - let wrapper catch
    }
  }
);
