// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/metrics.server`
 * Purpose: Thin binding of the published `@cogni-dao/metrics/http` route core to this node's container (service, goal reader, knowledge store) and to Next.js responses (story.0021).
 * Scope: Port binding and response mapping only. Request parsing, contract validation, error mapping and no-store headers live in the package; the routes keep only authentication and logging.
 * Invariants:
 *   - ONE_GOAL_PROGRESS_READ: `loadGoalsProgress` and the goals handler share the container's single reader, so SSR and the route read one instance.
 *   - SERVED_METRICS_PASS_THROUGH (story.0033): the goals read carries each KPI's `served` metrics, `orphans`, `servedTruncated` and `servedUnavailable` as the package returns them; this facade adds nothing.
 *   - TYPED_ERRORS: the package maps `MetricError` to its own status; anything else is a logged 503 (`reportUnexpected`).
 * Side-effects: IO (through the container's metric service and knowledge port)
 * Links: app/api/v1/metrics/**, bootstrap/capabilities/goal-metrics.ts
 * @public
 */

import {
  createMetricHttpHandlers,
  METRIC_HTTP_HEADERS,
  type MetricHttpResult,
  metricErrorResult,
} from "@cogni-dao/metrics/http";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";

function reportUnexpected() {
  getContainer().log.error(
    { errorCode: "metrics_unavailable" },
    "metric.operation_failed"
  );
}

export function metricHandlers() {
  const container = getContainer();
  return createMetricHttpHandlers({
    goalProgress: () => container.goalProgress(),
    service: () => container.goalMetrics,
    subject: async (id) => container.knowledgeStorePort?.getKnowledge(id),
    onUnexpectedError: reportUnexpected,
  });
}

export function metricResponse(result: MetricHttpResult): NextResponse {
  return NextResponse.json(result.body, {
    status: result.status,
    headers: METRIC_HTTP_HEADERS,
  });
}

/** For failures a route raises itself (for example a missing route context). */
export function metricHttpError(error: unknown): NextResponse {
  return metricResponse(metricErrorResult(error, reportUnexpected));
}

/** Same reader instance as core__goal_progress, for the Knowledge page seed. */
export async function loadGoalsProgress() {
  return getContainer().goalProgress();
}
