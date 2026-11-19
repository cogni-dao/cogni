// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/metrics/leases`
 * Purpose: Prometheus HTTP service discovery of every serving node lane (bug.5641). The env's Alloy reads this with
 *   the operator's METRICS_TOKEN and scrapes each lane as its own target through the relay route, so a new node is
 *   scraped with no config change.
 * Scope: Auth, one bounded lane read and the SD JSON. Target shape lives in `@features/node-deploy/lease-metrics`.
 * Invariants:
 *   - SAME_AUTH_AS_METRICS: the operator's METRICS_TOKEN bearer, constant-time compare (`../_bearer`).
 *   - NEVER_EMPTY_ON_FAILURE: a failed or over-bound lane read is 503. Alloy then keeps its last good target list; it
 *     never drops lanes because the store blinked or the list grew past its bound.
 * Side-effects: IO (release store read)
 * Links: https://cognidao.org/knowledge/lease-metrics-forwarding-design, https://prometheus.io/docs/prometheus/latest/http_sd/
 * @public
 */

import { NextResponse } from "next/server";

import { listLeaseScrapeTargets } from "@/bootstrap/capabilities/lease-metrics";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES } from "@/shared/observability";

import { isMetricsBearerAuthorized } from "../_bearer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const READ_DEADLINE_MS = 10_000;

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
    try {
      const { groups, truncated } = await listLeaseScrapeTargets(
        AbortSignal.timeout(READ_DEADLINE_MS)
      );
      if (truncated) {
        // Fail closed: Alloy keeps its last good list, and the error is logged, instead of dropping lanes silently.
        ctx.log.error(
          { reason: "lanes_truncated", lanes: groups.length },
          EVENT_NAMES.LEASE_METRICS_SCRAPE
        );
        return NextResponse.json(
          { error: "Lane list over its bound" },
          { status: 503 }
        );
      }
      return NextResponse.json(groups, {
        headers: { "Cache-Control": "no-store" },
      });
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
  }
);
