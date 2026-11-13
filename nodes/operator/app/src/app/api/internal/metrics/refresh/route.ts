// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/internal/metrics/refresh`
 * Purpose: Trusted scheduler-worker dispatch of the goal-metric refresh tick (story.0021).
 * Scope: Scheduler bearer, the node's receipt port, the grant-checked runner and logging. The tick logic (dispatch-key and body checks, idle answer, receipt) is `handleRefreshTick` from `@cogni-dao/metrics/http`.
 * Invariants:
 *   - DISPATCH_PRINCIPAL_AUTH: Bearer SCHEDULER_API_TOKEN, like `/api/internal/jobs/<id>`.
 *   - DISPATCH_KEY_BOUND: Idempotency-Key must be `<nodeId>/metrics:<nodeId>:refresh/<iso>`.
 *   - IDLE_TICK_IS_FREE (story.0031): an idle tick is answered from the in-memory refresh clock with no receipt, grant read or database work; the container is touched only after authorization.
 *   - RECEIPTS_SEPARATE: dispatch receipts (execution_requests) are distinct from the
 *     append-only measurement attempts the metrics package writes.
 * Side-effects: IO (execution request rows, metric observations, logs)
 * Links: bootstrap/jobs/metrics-refresh.job.ts, @cogni-dao/metrics handleRefreshTick
 * @internal
 */

import { verifySchedulerBearer } from "@cogni/node-shared";
import { handleRefreshTick } from "@cogni-dao/metrics/http";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  metricsRefreshScheduleId,
  runMetricsRefresh,
} from "@/bootstrap/jobs/metrics-refresh.job";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES } from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "metrics.refresh.internal", auth: { mode: "none" } },
  async (ctx, request) => {
    const nodeId = getNodeId();
    // Getters: the container is touched only after the request is authorized.
    const result = await handleRefreshTick(
      {
        get service() {
          return getContainer().goalMetrics;
        },
        get receipts() {
          return getContainer().executionRequestPort;
        },
        run: runMetricsRefresh,
      },
      {
        authorized: verifySchedulerBearer(
          request.headers.get("authorization"),
          serverEnv().SCHEDULER_API_TOKEN
        ),
        idempotencyKey: request.headers.get("idempotency-key"),
        keyPrefix: `${nodeId}/${metricsRefreshScheduleId(nodeId)}/`,
        readBody: () => request.json(),
      }
    );
    // App-local event: ctx.log directly (logEvent types only the shared EventName).
    if (result.event)
      ctx.log.info(
        {
          event: EVENT_NAMES.METRIC_REFRESH_COMPLETE,
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          ...result.event,
        },
        EVENT_NAMES.METRIC_REFRESH_COMPLETE
      );
    return NextResponse.json(result.body, { status: result.status });
  }
);
