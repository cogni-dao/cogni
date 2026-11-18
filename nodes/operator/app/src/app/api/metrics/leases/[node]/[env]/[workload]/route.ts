// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/metrics/leases/[node]/[env]/[workload]`
 * Purpose: Relay one serving lane's `/api/metrics` to the env's Alloy (bug.5641). The lane only accepts its derived
 *   token, which the operator holds and Alloy does not, so Alloy scrapes each lane through this route.
 * Scope: Auth, path validation, one lane relay. The relay never parses or rewrites tenant text: Alloy applies the
 *   trusted labels, limits and `up`.
 * Invariants:
 *   - SAME_AUTH_AS_METRICS: the operator's METRICS_TOKEN bearer, constant-time compare (`../../../../_bearer`).
 *   - FAILURE_IS_NON_200: an unknown, unauthorised, oversized or unreachable lane answers 502 (404 when not serving),
 *     so Prometheus records `up = 0` for that lane alone.
 *   - BOUNDED_LOG: a failed relay logs one `lease_metrics_scrape` warn with node, env, workload, reason and upstream
 *     status. No token, host or body is logged.
 * Side-effects: IO (release store read, outbound HTTPS to one lane)
 * Links: https://cognidao.org/knowledge/lease-metrics-forwarding-design, bug.5641
 * @public
 */

import { NextResponse } from "next/server";

import { relayLeaseMetrics } from "@/bootstrap/capabilities/lease-metrics";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { parseLeaseLaneKey } from "@/features/node-deploy/lease-metrics";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES } from "@/shared/observability";

import { isMetricsBearerAuthorized } from "../../../../_bearer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The relay as a whole; the lane fetch has its own shorter deadline. Alloy's scrape timeout is longer. */
const RELAY_DEADLINE_MS = 12_000;

interface RouteParams {
  params: Promise<{ node: string; env: string; workload: string }>;
}

export const GET = wrapRouteHandlerWithLogging<RouteParams>(
  // meta.metrics: the scraper route id is excluded from user-traffic HTTP metrics and from success-log noise.
  { routeId: "meta.metrics", auth: { mode: "none" } },
  async (ctx, request, _user, routeCtx) => {
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
    const key = routeCtx ? parseLeaseLaneKey(await routeCtx.params) : null;
    if (!key) {
      return NextResponse.json({ error: "Invalid lane" }, { status: 404 });
    }

    let outcome: Awaited<ReturnType<typeof relayLeaseMetrics>>;
    try {
      outcome = await relayLeaseMetrics(
        configuredToken,
        key,
        AbortSignal.timeout(RELAY_DEADLINE_MS)
      );
    } catch {
      ctx.log.error(
        { ...key, reason: "lanes_unavailable" },
        EVENT_NAMES.LEASE_METRICS_SCRAPE
      );
      return NextResponse.json(
        { error: "Lane read unavailable" },
        { status: 503 }
      );
    }
    if (!outcome.ok) {
      ctx.log.warn(
        {
          ...key,
          reason: outcome.reason,
          upstreamStatus: "status" in outcome ? outcome.status : undefined,
        },
        EVENT_NAMES.LEASE_METRICS_SCRAPE
      );
      return NextResponse.json(
        { error: outcome.reason },
        { status: outcome.reason === "not_serving" ? 404 : 502 }
      );
    }
    return new NextResponse(outcome.body, {
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
);
