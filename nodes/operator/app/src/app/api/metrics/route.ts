// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/metrics`
 * Purpose: Prometheus metrics endpoint for Alloy/Prometheus scraping.
 * Scope: Exposes metrics registry. Protected by bearer token auth. Does not define or record metrics.
 * Invariants: METRICS_TOKEN required; constant-time compare; auth header capped at 512 bytes.
 * Side-effects: IO (reads metrics registry, records HTTP metrics)
 * Notes: Bearer token auth case-insensitive. Wrapped for consistent reqId and HTTP metrics.
 * Links: Consumed by Alloy scraper, Prometheus, or Grafana Cloud.
 * @public
 */

import { NextResponse } from "next/server";

import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";
import { metricsRegistry } from "@/shared/observability";

import { isMetricsBearerAuthorized } from "./_bearer";

// Force Node.js runtime (prom-client not Edge-compatible)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "meta.metrics", auth: { mode: "none" } },
  async (_ctx, request) => {
    const env = serverEnv();
    const configuredToken = env.METRICS_TOKEN;

    // METRICS_TOKEN must be set in all environments
    if (!configuredToken) {
      return NextResponse.json(
        { error: "METRICS_TOKEN not configured" },
        { status: 500 }
      );
    }

    // Require valid bearer token auth
    if (
      !isMetricsBearerAuthorized(
        request.headers.get("authorization"),
        configuredToken
      )
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const metrics = await metricsRegistry.metrics();
    return new NextResponse(metrics, {
      headers: {
        "Content-Type": metricsRegistry.contentType,
        "Cache-Control": "no-store",
      },
    });
  }
);
