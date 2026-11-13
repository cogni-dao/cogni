// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/expectations/route`
 * Purpose: GET /api/v1/work/items/:id/expectations — the hypotheses a work item tracks, their recorded outcomes and, for each KPI binding pinned to one of the item's moves, the live prediction assessment.
 * Scope: Authenticated read. One bounded EDO read from the knowledge store plus one batched prediction read from the goal-metric service; the item is read without the metric chain (stored move ids only). No writes, no metric refresh.
 * Invariants: Never invents an answer: an unreadable store, item or assessment is HTTP 503 `unavailable` (or 200 with the observed text `unavailable`/`unresolved`); a binding is matched to a move only when both the metric id and the pinned baseline observation id agree.
 * Side-effects: IO (HTTP response, Doltgres reads, goal-metric reads)
 * Links: packages/knowledge-base-ui/src/work-edo.tsx (node-template), story.0016
 * @internal
 */

import { KpiBindingsSchema } from "@cogni-dao/metrics/contracts";
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
    const reply = (body: unknown, status: number, errorCode?: string) => {
      // App-local event: ctx.log directly (logEvent types only the shared EventName).
      ctx.log.info(
        {
          event: EVENT_NAMES.WORK_EXPECTATIONS_READ,
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          status,
          durationMs: Date.now() - started,
          outcome: status < 400 && !errorCode ? "success" : "error",
          ...(errorCode ? { errorCode } : {}),
        },
        EVENT_NAMES.WORK_EXPECTATIONS_READ
      );
      return NextResponse.json(body, {
        status,
        headers: { "Cache-Control": "no-store" },
      });
    };
    try {
      if (!user) return reply({ error: "unauthorized" }, 401, "unauthorized");
      if (!context) throw new Error("context required");
      const { id } = await context.params;
      const container = getContainer();
      if (!container.knowledgeStorePort?.readWorkEdo)
        return reply({ error: "unavailable" }, 503, "unavailable");
      const [itemResult, pageResult] = await Promise.allSettled([
        getWorkItem(id, { signal: request.signal, chain: false }),
        container.knowledgeStorePort.readWorkEdo(id, request.signal),
      ]);
      if (
        itemResult.status !== "fulfilled" ||
        pageResult.status !== "fulfilled"
      )
        return reply({ error: "unavailable" }, 503, "unavailable");
      const item = itemResult.value,
        page = pageResult.value;
      if (!item) return reply({ error: "not found" }, 404, "not_found");
      const entries = page.items.map(({ hypothesis, outcomes, truncated }) => ({
        hypothesis,
        outcomes,
        truncated,
        parsed: KpiBindingsSchema.safeParse(hypothesis.kpiBindings ?? []),
      }));
      const matched = entries.flatMap((entry) =>
        entry.parsed.success
          ? entry.parsed.data.filter((binding) =>
              item.moves?.some(
                (move) =>
                  move.metricId === binding.metricId &&
                  move.baselineObservationId !== null &&
                  move.baselineObservationId === binding.baselineObservationId
              )
            )
          : []
      );
      let evidenceUnavailable = matched.length > 0 && !container.goalMetrics;
      const assessments =
        container.goalMetrics && matched.length
          ? await container.goalMetrics
              .predictionBatch(matched, request.signal)
              .catch(() => {
                evidenceUnavailable = true;
                return [];
              })
          : [];
      if (assessments.length !== matched.length) evidenceUnavailable = true;
      let cursor = 0;
      const items = entries.map(
        ({ hypothesis, outcomes, truncated, parsed }) => ({
          id: hypothesis.id,
          title: hypothesis.title,
          content: hypothesis.content,
          outcomes,
          truncated,
          predictions: parsed.success
            ? parsed.data.map((binding) => {
                const same = item.moves?.some(
                  (move) =>
                    move.metricId === binding.metricId &&
                    move.baselineObservationId !== null &&
                    move.baselineObservationId === binding.baselineObservationId
                );
                const result = same ? assessments[cursor++] : undefined;
                const assessment = result?.assessment;
                if (
                  same &&
                  (!assessment ||
                    result?.viewState === "error" ||
                    assessment.reason === "metric_authority_unavailable")
                )
                  evidenceUnavailable = true;
                const observed = assessment
                  ? [
                      assessment.status,
                      assessment.value == null
                        ? null
                        : `${assessment.value} ${assessment.unit}`,
                      assessment.observationId,
                      assessment.reason,
                      assessment.deadline,
                      result?.viewState,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : "unavailable (metrics_unavailable)";
                return {
                  metricId: binding.metricId,
                  expected: `${binding.comparator} ${binding.target.value} ${binding.target.unit}`,
                  observed: same
                    ? observed
                    : "unresolved (metric or baseline mismatch)",
                };
              })
            : [
                {
                  metricId: "",
                  expected: "invalid binding",
                  observed: "unresolved",
                },
              ],
        })
      );
      return reply(
        { items, truncated: page.truncated },
        200,
        evidenceUnavailable ? "metrics_unavailable" : undefined
      );
    } catch {
      return reply({ error: "unavailable" }, 503, "unavailable");
    }
  }
);
