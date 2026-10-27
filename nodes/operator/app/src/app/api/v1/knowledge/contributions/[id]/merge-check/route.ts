// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/contributions/[id]/merge-check/route`
 * Purpose: Explicit native conflict diagnostic for an authenticated reviewer.
 * Scope: Thin operator route. Does not mutate data or confer merge permission.
 * Invariants: VALIDATE_IO; no caching; caller cannot choose SQL, refs or tables.
 * Side-effects: IO (HTTP and admitted native reads/session checkout)
 * Links: https://cognidao.org/work/items/spike.5016
 * @public
 */
import { ContributionMergeCheckResponseSchema } from "@cogni/node-contracts";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";
import { handleMergeCheck } from "../../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "knowledge.contributions.merge_check",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    const startedAt = performance.now();
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    const response = await handleMergeCheck(request, id, sessionUser);
    const parsed = ContributionMergeCheckResponseSchema.safeParse(
      await response.clone().json()
    );
    logEvent(ctx.log, EVENT_NAMES.KNOWLEDGE_MERGE_CHECK_COMPLETE, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      status: response.status,
      outcome:
        parsed.success && parsed.data.status !== "unavailable"
          ? "success"
          : "error",
      errorCode: parsed.success ? parsed.data.reason : "invalid_request",
      previewStatus: parsed.success ? parsed.data.status : "unavailable",
      conflictTableCount: parsed.success ? parsed.data.conflicts.length : 0,
      durationMs: performance.now() - startedAt,
    });
    return response;
  }
);
