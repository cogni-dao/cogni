// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/temporal/health`
 * Purpose: Authenticated read-only proof of the node's shared Temporal substrate.
 * Scope: Runs one bounded diagnostic and returns its artifact/poller evidence. No workflow or schedule mutations.
 * Invariants: Emits exactly one route-specific terminal health event per completed diagnostic.
 * Side-effects: IO (Temporal, scheduler-worker HTTP, logs, metrics)
 * Links: task.5238, docs/spec/temporal-patterns.md
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { checkSharedTemporalHealth } from "@/bootstrap/jobs/checkSharedTemporalHealth.job";

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
      event: "substrate.temporal.health_checked",
      outcome: result.status === "healthy" ? "success" : "error",
      reasonCode: result.reason,
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
      durationMs: result.durationMs,
    };

    if (result.status === "healthy") {
      ctx.log.info(event, "shared Temporal substrate health check complete");
    } else {
      ctx.log.error(event, "shared Temporal substrate health check failed");
    }

    return NextResponse.json(result, {
      status: result.status === "healthy" ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
);
