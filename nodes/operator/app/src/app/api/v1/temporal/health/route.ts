// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/temporal/health`
 * Purpose: Developer-gated read-only proof of the node's shared Temporal substrate.
 * Scope: Runs one bounded diagnostic and returns its artifact/poller evidence. No workflow or schedule mutations.
 * Invariants: Requires node.flight; rate limits callers; emits one terminal event; redacts Workflow IDs.
 * Side-effects: IO (Temporal, scheduler-worker HTTP, logs, metrics)
 * Links: task.5238, docs/spec/temporal-patterns.md
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { checkSharedTemporalHealth } from "@/bootstrap/jobs/checkSharedTemporalHealth.job";
import { getNodeId } from "@/shared/config";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEALTH_RATE_WINDOW_MS = 5_000;
const lastRequestByActor = new Map<string, number>();

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "temporal.health",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser) => {
    const nodeId = getNodeId();
    const authorization = getContainer().authorization;
    if (!authorization) {
      return NextResponse.json(
        { error: "authorization unavailable", code: "authz_unavailable" },
        { status: 503 }
      );
    }
    const decision = await authorization.check({
      actorId: `user:${sessionUser.id}`,
      action: "node.flight",
      resource: `node:${nodeId}`,
      context: { tenantId: nodeId, nodeId },
    });
    if (decision.decision !== "allow") {
      const unavailable = decision.code === "authz_unavailable";
      return NextResponse.json(
        {
          error: unavailable ? "authorization unavailable" : "forbidden",
          code: unavailable ? "authz_unavailable" : "authz_denied",
        },
        { status: unavailable ? 503 : 403 }
      );
    }
    const nowMs = Date.now();
    const previousRequestMs = lastRequestByActor.get(sessionUser.id);
    if (
      previousRequestMs !== undefined &&
      nowMs - previousRequestMs < HEALTH_RATE_WINDOW_MS
    ) {
      return NextResponse.json(
        { error: "rate limit exceeded", code: "rate_limited" },
        { status: 429, headers: { "Retry-After": "5" } }
      );
    }
    lastRequestByActor.set(sessionUser.id, nowMs);
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

/** @internal Test-only reset for the per-process actor rate gate. */
export function resetTemporalHealthRateGateForTest(): void {
  lastRequestByActor.clear();
}
