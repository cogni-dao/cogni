// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/ai/runs`
 * Purpose: HTTP endpoint to list graph runs for the authenticated user.
 * Scope: Validates query params via contract, queries graph_runs via GraphRunRepository port. Does not contain business logic.
 * Invariants: Runs scoped to authenticated user via requested_by filter. Cache-Control: no-store to prevent stale lists.
 * Side-effects: IO (reads graph_runs via GraphRunRepository)
 * Links: src/contracts/ai.runs.v1.contract.ts, packages/scheduler-core/src/ports/schedule-run.port.ts
 * @public
 */

import { toUserId, userActor } from "@cogni/ids";
import { listRunsOperation } from "@cogni/node-contracts";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { logRequestWarn, type RequestContext } from "@/shared/observability";

export const dynamic = "force-dynamic";

function handleRouteError(
  ctx: RequestContext,
  error: unknown
): NextResponse | null {
  if (error && typeof error === "object" && "issues" in error) {
    logRequestWarn(ctx.log, error, "VALIDATION_ERROR");
    return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  }
  return null;
}

/**
 * GET /api/v1/ai/runs
 *
 * Lists graph runs for the authenticated user, ordered by started_at DESC.
 * Supports filtering by status and runKind, with cursor-based pagination.
 *
 * Query params: status?, runKind?, limit? (default 20, max 100), cursor? (ISO datetime)
 *
 * HTTP responses:
 * - 200: { runs: RunCard[], nextCursor?: string }
 * - 400: Invalid query params
 * - 401: Not authenticated
 */
export const GET = wrapRouteHandlerWithLogging(
  { routeId: "ai.runs.list", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    try {
      const { searchParams } = new URL(request.url);

      const input = listRunsOperation.input.parse({
        status: searchParams.get("status") ?? undefined,
        runKind: searchParams.get("runKind") ?? undefined,
        limit: searchParams.has("limit")
          ? Number(searchParams.get("limit"))
          : undefined,
        cursor: searchParams.get("cursor") ?? undefined,
      });

      const container = getContainer();

      // scope=system: query as system tenant (same pattern as governance activity route)
      const isSystemScope = searchParams.get("scope") === "system";
      const queryUserId = isSystemScope
        ? COGNI_SYSTEM_PRINCIPAL_USER_ID
        : sessionUser.id;
      const actorId = userActor(toUserId(queryUserId));

      const runs = await container.graphRunRepository.listRunsByUser(
        actorId,
        queryUserId,
        {
          ...(input.status ? { status: input.status } : {}),
          ...(input.runKind ? { runKind: input.runKind } : {}),
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        }
      );

      // Detect next page: adapter fetches limit+1 rows
      const hasMore = runs.length > input.limit;
      const pageRuns = hasMore ? runs.slice(0, input.limit) : runs;

      const result = listRunsOperation.output.parse({
        runs: pageRuns.map((run) => ({
          id: run.id,
          runId: run.runId,
          graphId: run.graphId,
          runKind: run.runKind,
          status: run.status,
          statusLabel: null,
          requestedBy: run.requestedBy,
          startedAt: run.startedAt?.toISOString() ?? null,
          completedAt: run.completedAt?.toISOString() ?? null,
          errorCode: run.errorCode,
          errorMessage: run.errorMessage,
          stateKey: run.stateKey,
        })),
        ...(hasMore && pageRuns.length > 0
          ? {
              nextCursor:
                pageRuns[pageRuns.length - 1]?.startedAt?.toISOString(),
            }
          : {}),
      });

      return NextResponse.json(result, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error;
    }
  }
);
