// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/metrics/leases`
 * Purpose: One merged Prometheus exposition of every serving node lane's `/api/metrics` (bug.5641). The env's
 *   Alloy scrapes this with the operator's own METRICS_TOKEN and ships it to Mimir, so Akash node apps get request
 *   metrics without their own scraper, Alloy or write credential.
 * Scope: Auth, one bounded collect pass and the response. Derivation, label stamping and fan-out live in
 *   `@features/node-deploy/lease-metrics`.
 * Invariants:
 *   - SAME_AUTH_AS_METRICS: the operator's METRICS_TOKEN bearer, constant-time compare (`../_bearer`).
 *   - FAIL_OPEN_PER_LANE: a lane that is slow, huge or unauthorised reads `cogni_lease_scrape_up 0` and never fails
 *     the response. A lane READ failure is 503, so Alloy's own `up` for this job goes 0 (never a silent empty).
 *   - ONE_EVENT_PER_PASS: one `lease_metrics_scrape` event with bounded counts. No token, host or body is logged.
 * Side-effects: IO (release store read, outbound HTTPS to lanes)
 * Links: https://cognidao.org/knowledge/lease-metrics-forwarding-design, bug.5641
 * @public
 */

import { NextResponse } from "next/server";

import { createLeaseMetricsCollector } from "@/bootstrap/capabilities/lease-metrics";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES } from "@/shared/observability";

import { isMetricsBearerAuthorized } from "../_bearer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The whole pass; Alloy's scrape timeout for this job is longer than this. */
const PASS_DEADLINE_MS = 20_000;

export const GET = wrapRouteHandlerWithLogging(
  // meta.metrics: the scraper route id is excluded from user-traffic HTTP metrics and from success-log noise.
  { routeId: "meta.metrics", auth: { mode: "none" } },
  async (ctx, request) => {
    const configuredToken = serverEnv().METRICS_TOKEN;
    if (!configuredToken) {
      return NextResponse.json(
        { error: "METRICS_TOKEN not configured" },
        { status: 500 }
      );
    }
    if (
      !isMetricsBearerAuthorized(
        request.headers.get("authorization"),
        configuredToken
      )
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const started = performance.now();
    let report: Awaited<
      ReturnType<ReturnType<typeof createLeaseMetricsCollector>>
    >;
    try {
      report = await createLeaseMetricsCollector(configuredToken)(
        AbortSignal.timeout(PASS_DEADLINE_MS)
      );
    } catch {
      ctx.log.error(
        { reason: "lanes_unavailable" },
        EVENT_NAMES.LEASE_METRICS_SCRAPE
      );
      return NextResponse.json(
        { error: "Lane read unavailable" },
        { status: 503 }
      );
    }
    ctx.log.info(
      {
        lanes: report.lanes,
        scraped: report.scraped,
        failed: report.failed,
        truncated: report.truncated,
        reasons: report.reasons,
        durationMs: Math.round(performance.now() - started),
      },
      EVENT_NAMES.LEASE_METRICS_SCRAPE
    );
    return new NextResponse(report.text, {
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
);
