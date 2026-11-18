// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/metrics/read/api/v1/query`
 * Purpose: The Prometheus `query` endpoint a node app's `MimirMetricsAdapter` calls (story.5169). The node's
 *   `PROMETHEUS_QUERY_URL` is `https://<releasing operator>/api/metrics/read`, so the client appends
 *   `/api/v1/query` and lands here with HTTP Basic (node UUID : its derived lane token).
 * Scope: Binds the route; every rule is in `../../../_handle`.
 * Invariants: SCOPED_TO_THE_CALLER (`_handle`). Outside the session proxy (not under `/api/v1`).
 * Side-effects: IO (outbound HTTPS to the Grafana datasource proxy)
 * Links: https://cognidao.org/work/items/story.5169
 * @public
 */

import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

import { handleNodeMetricsRead } from "../../../_handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// meta.metrics: machine metrics traffic is excluded from user-traffic HTTP metrics and success-log noise.
const handler = wrapRouteHandlerWithLogging(
  { routeId: "meta.metrics", auth: { mode: "none" } },
  (ctx, request) => handleNodeMetricsRead("query", ctx, request)
);

export const GET = handler;
export const POST = handler;
