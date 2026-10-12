// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/temporal/health`
 * Purpose: Authenticated read-only proof of the node's shared Temporal substrate.
 * Scope: Runs one bounded diagnostic and returns its artifact/poller evidence. No workflow or schedule mutations.
 * Invariants: Emits exactly one terminal event with correlation IDs; redacts those IDs from the auth-only HTTP response.
 * Side-effects: IO (Temporal, scheduler-worker HTTP, logs, metrics)
 * Links: task.5238, docs/spec/temporal-patterns.md
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { checkSharedTemporalHealth } from "@/bootstrap/jobs/checkSharedTemporalHealth.job";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "temporal.health",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx) => {
    const result = await checkSharedTemporalHealth();
    const event = {
      event: EVENT_NAMES.SUBSTRATE_TEMPORAL_HEALTH_CHECKED,
      outcome: result.status === "healthy" ? "success" : "error",
      reasonCode: result.reason,
      mode: result.mode,
      nodeId: result.nodeId,
      namespace: result.namespace,
      taskQueue: result.taskQueue,
      workflowPollerStatus: result.pollers.workflow.status,
      workflowPollerCount: result.pollers.workflow.pollerCount,
      activityPollerStatus: result.pollers.activity.status,
      activityPollerCount: result.pollers.activity.pollerCount,
      appBuildSha: result.app.buildSha,
      workerSha: result.worker?.sha ?? null,
      workerImageDigest: result.worker?.imageDigest ?? null,
      scheduleDeclaredCount: result.schedules.declaredCount,
      scheduleObservedCount: result.schedules.observedCount,
      scheduleReconciledCount: result.schedules.reconciledCount,
      schedulePausedCount: result.schedules.pausedCount,
      scheduleDriftCount: result.schedules.driftCount,
      scheduleDriftReasons: result.schedules.driftReasons,
      dueExecutionCount: result.schedules.dueCount,
      terminalExecutionCount: result.schedules.terminalCount,
      failedExecutionCount: result.schedules.failedCount,
      staleExecutionCount: result.schedules.staleCount,
      missedExecutionCount: result.schedules.missedCount,
      latestDueWorkflowId:
        result.schedules.latestDueExecution?.workflowId ?? null,
      latestDueWorkflowRunId:
        result.schedules.latestDueExecution?.firstExecutionRunId ?? null,
      latestDueWorkflowStatus:
        result.schedules.latestDueExecution?.status ?? null,
      durationMs: result.durationMs,
    };

    if (result.status === "healthy") {
      ctx.log.info(event, "shared Temporal substrate health check complete");
    } else {
      ctx.log.error(event, "shared Temporal substrate health check failed");
    }

    const latestDueExecution = result.schedules.latestDueExecution;
    const publicResult = {
      ...result,
      schedules: {
        ...result.schedules,
        latestDueExecution: latestDueExecution
          ? {
              ...latestDueExecution,
              workflowId: null,
              firstExecutionRunId: null,
            }
          : null,
      },
    };

    return NextResponse.json(publicResult, {
      status: result.status === "healthy" ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
);
