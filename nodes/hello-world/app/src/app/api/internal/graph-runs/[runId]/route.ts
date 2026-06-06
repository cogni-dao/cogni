// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/internal/graph-runs/[runId]`
 * Purpose: Internal endpoint for scheduler-worker to update graph_runs status in this node's database.
 * Scope: Auth-protected PATCH — delegates to GraphRunRepository.markRunStarted / markRunCompleted based on requested status. Worker holds no DB credentials; this is the only update path.
 * Invariants:
 *   - INTERNAL_API_SHARED_SECRET: Requires Bearer SCHEDULER_API_TOKEN
 *   - Status transitions remain monotonic (adapter enforces)
 * Side-effects: IO (updates graph_runs via GraphRunRepository)
 * Links: graph-runs.update.internal.v1.contract, task.0280
 * @internal
 */

import { SYSTEM_ACTOR } from "@cogni/ids/system";
import {
  InternalUpdateGraphRunInputSchema,
  type InternalUpdateGraphRunOutput,
} from "@cogni/node-contracts";
import { verifySchedulerBearer } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ runId: string }>;
}

export const PATCH = wrapRouteHandlerWithLogging<RouteParams>(
  { routeId: "graph-runs.update.internal", auth: { mode: "none" } },
  async (ctx, request, _sessionUser, routeParams) => {
    const env = serverEnv();
    const log = ctx.log;

    if (
      !verifySchedulerBearer(
        request.headers.get("authorization"),
        env.SCHEDULER_API_TOKEN
      )
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!routeParams) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { runId } = await routeParams.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = InternalUpdateGraphRunInputSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ errors: parsed.error.issues }, "Invalid request body");
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const { status, traceId, errorMessage, errorCode } = parsed.data;
    const container = getContainer();

    try {
      if (status === "running") {
        await container.graphRunRepository.markRunStarted(
          SYSTEM_ACTOR,
          runId,
          traceId ?? undefined
        );
      } else {
        await container.graphRunRepository.markRunCompleted(
          SYSTEM_ACTOR,
          runId,
          status,
          errorMessage,
          errorCode
        );
      }
    } catch (err) {
      log.error({ runId, status, err }, "Failed to update graph run");
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }

    const response: InternalUpdateGraphRunOutput = { ok: true, runId };
    return NextResponse.json(response, { status: 200 });
  }
);
