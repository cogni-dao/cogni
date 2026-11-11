// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/contributions/[id]/diff/route`
 * Purpose: GET the dolt_diff for a contribution branch versus main.
 * Scope: Auth-protected GET. Powers operator review before merge.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER.
 * Side-effects: IO (HTTP response, Doltgres dolt_diff read via container service)
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";
import { handleDiff } from "../../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "knowledge.contributions.diff",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    const startedAt = performance.now();
    let status = 500;
    try {
      if (!context) throw new Error("context required for dynamic routes");
      const { id } = await context.params;
      const response = await handleDiff(id, sessionUser);
      status = response.status;
      return response;
    } finally {
      logEvent(ctx.log, EVENT_NAMES.KNOWLEDGE_CONTRIBUTION_DIFF_COMPLETE, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        status,
        outcome: status < 400 ? "success" : "error",
        errorCode:
          status === 404
            ? "contribution_not_found"
            : status === 503
              ? "backend_unavailable"
              : status >= 400
                ? "diff_failed"
                : undefined,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  }
);
