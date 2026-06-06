// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/ai/threads`
 * Purpose: HTTP endpoint to list threads for the authenticated user.
 * Scope: Validates query params, delegates to threads facade. Does not access database directly.
 * Invariants: Threads scoped to authenticated user via RLS. Cache-Control: no-store to prevent stale lists.
 * Side-effects: IO (reads threads via ThreadPersistencePort)
 * Links: src/contracts/ai.threads.v1.contract.ts, src/app/_facades/ai/threads.server.ts
 * @public
 */

import { listThreadsOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { listThreadsFacade } from "@/app/_facades/ai/threads.server";
import { getSessionUser } from "@/app/_lib/auth/session";
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

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "ai.threads.list",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    try {
      const { searchParams } = new URL(request.url);
      const rawLimit = searchParams.get("limit");
      const rawOffset = searchParams.get("offset");

      const input = listThreadsOperation.input.parse({
        limit: rawLimit ? Number(rawLimit) : undefined,
        offset: rawOffset ? Number(rawOffset) : undefined,
      });

      if (!sessionUser) throw new Error("sessionUser required");

      const result = await listThreadsFacade({
        sessionUser,
        limit: input.limit,
        offset: input.offset,
      });

      return NextResponse.json(listThreadsOperation.output.parse(result), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error;
    }
  }
);
