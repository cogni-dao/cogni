// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/expectations/route`
 * Purpose: GET /api/v1/work/items/:id/expectations — the hypotheses a work item tracks, their recorded outcomes and, for each KPI binding pinned to one of the item's moves, the live prediction assessment.
 * Scope: Auth, the item and EDO reads, and the log line. `handleWorkExpectations` from @cogni-dao/metrics/http owns the binding match, the one prediction batch, the page and the terminal event (story.0085). The item is read without the metric chain (stored move ids only); no writes, no metric refresh.
 * Invariants: Never invents an answer: an unreadable store, item or assessment is HTTP 503 `unavailable` (or 200 with the observed text `unavailable`/`unresolved`).
 * Side-effects: IO (HTTP response, Doltgres reads, goal-metric reads)
 * Links: hub work-item-view-capability, story.0016
 * @public
 */

import { handleWorkExpectations } from "@cogni-dao/metrics/http";
import { NextResponse } from "next/server";
import { getWorkItem } from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "work.expectations.get",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, user, context) => {
    const started = Date.now();
    const headers = { "Cache-Control": "no-store" };
    // App-local event: ctx.log directly (logEvent types only the shared EventName).
    const log = (fields: Record<string, unknown>) =>
      ctx.log.info(
        {
          event: EVENT_NAMES.WORK_EXPECTATIONS_READ,
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          durationMs: Date.now() - started,
          ...fields,
        },
        EVENT_NAMES.WORK_EXPECTATIONS_READ
      );
    if (!context) throw new Error("context required");
    if (!user) {
      log({ status: 401, outcome: "error", errorCode: "unauthorized" });
      return NextResponse.json(
        { error: "unauthorized" },
        { status: 401, headers }
      );
    }
    const { id } = await context.params;
    const container = getContainer();
    const readWorkEdo = container.knowledgeStorePort?.readWorkEdo?.bind(
      container.knowledgeStorePort
    );
    const result = await handleWorkExpectations({
      workItemId: id,
      readItem: (signal) =>
        getWorkItem(id, {
          ...(signal && { signal }),
          chain: false,
          artifacts: false,
        }),
      readEdo: readWorkEdo && ((signal) => readWorkEdo(id, signal)),
      predictionBatch: container.goalMetrics?.predictionBatch.bind(
        container.goalMetrics
      ),
      signal: request.signal,
    }).catch(() => undefined);
    if (!result) {
      log({ status: 503, outcome: "error", errorCode: "unavailable" });
      return NextResponse.json(
        { error: "unavailable" },
        { status: 503, headers }
      );
    }
    log({ ...result.event });
    return NextResponse.json(result.body, { status: result.status, headers });
  }
);
