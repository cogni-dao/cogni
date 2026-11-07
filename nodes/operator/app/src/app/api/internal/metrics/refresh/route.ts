// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/internal/metrics/refresh`
 * Purpose: Trusted scheduler-worker dispatch of the goal-metric refresh tick (story.0021).
 * Scope: Auth + dispatch-key validation + idempotent receipt; the work is `runMetricsRefresh`.
 * Invariants:
 *   - DISPATCH_PRINCIPAL_AUTH: Bearer SCHEDULER_API_TOKEN, like `/api/internal/jobs/<id>`.
 *   - DISPATCH_KEY_BOUND: Idempotency-Key must be `<nodeId>/metrics:<nodeId>:refresh/<iso>`.
 *   - RECEIPTS_SEPARATE: dispatch receipts (execution_requests) are distinct from the
 *     append-only measurement attempts the metrics package writes.
 * Side-effects: IO (execution request rows, metric observations, logs)
 * Links: bootstrap/jobs/metrics-refresh.job.ts, @cogni-dao/metrics refreshDue
 * @internal
 */

import { createHash, randomUUID } from "node:crypto";
import { verifySchedulerBearer } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { z } from "zod";
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
    if (
      !verifySchedulerBearer(
        request.headers.get("authorization"),
        serverEnv().SCHEDULER_API_TOKEN
      )
    )
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const nodeId = getNodeId();
    const key = request.headers.get("idempotency-key");
    const prefix = `${nodeId}/${metricsRefreshScheduleId(nodeId)}/`;
    if (
      !key?.startsWith(prefix) ||
      !z.iso.datetime({ offset: true }).safeParse(key.slice(prefix.length))
        .success
    )
      return NextResponse.json(
        { error: "invalid_dispatch_key" },
        { status: 400 }
      );
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const body = z
      .strictObject({ executionGrantId: z.uuid() })
      .safeParse(input);
    if (!body.success)
      return NextResponse.json({ error: "grant_required" }, { status: 400 });
    const requests = getContainer().executionRequestPort;
    const hash = createHash("sha256")
      .update(JSON.stringify(body.data))
      .digest("hex");
    const previous = await requests.checkIdempotency(key, hash);
    if (previous.status === "cached")
      return NextResponse.json({
        ok: previous.request.ok === true,
        replay: true,
      });
    if (previous.status === "pending" || previous.status === "stale")
      return NextResponse.json({ error: "dispatch_pending" }, { status: 409 });
    if (previous.status === "mismatch")
      return NextResponse.json(
        { error: "dispatch_payload_mismatch" },
        { status: 422 }
      );
    try {
      await requests.createPendingRequest(key, hash, randomUUID(), null);
    } catch (error) {
      const raced = await requests.checkIdempotency(key, hash);
      if (raced.status !== "new")
        return NextResponse.json(
          { error: "dispatch_pending" },
          { status: 409 }
        );
      throw error;
    }
    try {
      const result = await runMetricsRefresh(body.data.executionGrantId);
      await requests.finalizeRequest(key, { ok: true, errorCode: null });
      const failed = result.observations.filter(
        (x) => x.status === "error" || x.status === "unavailable"
      );
      // App-local event: ctx.log directly (logEvent types only the shared EventName).
      ctx.log.info(
        {
          event: EVENT_NAMES.METRIC_REFRESH_COMPLETE,
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          scanned: result.scanned,
          measuredCount: result.observations.length,
          errorCount: failed.length,
          outcome: failed.length ? "error" : "success",
          errorCode: failed.length ? "metric_source_unavailable" : null,
        },
        EVENT_NAMES.METRIC_REFRESH_COMPLETE
      );
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      await requests.finalizeRequest(key, { ok: false, errorCode: "internal" });
      throw error;
    }
  }
);
