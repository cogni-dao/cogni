// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/ai/threads/[stateKey]`
 * Purpose: HTTP endpoint to load or delete a single thread by stateKey.
 * Scope: Validates stateKey param, delegates to threads facade. Does not access database directly.
 * Invariants: Thread scoped to authenticated user via RLS. Cache-Control: no-store on GET.
 * Side-effects: IO (reads/writes threads via ThreadPersistencePort)
 * Links: src/contracts/ai.threads.v1.contract.ts, src/app/_facades/ai/threads.server.ts
 * @public
 */

import {
  deleteThreadOperation,
  loadThreadOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import {
  deleteThreadFacade,
  loadThreadFacade,
} from "@/app/_facades/ai/threads.server";
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
    return NextResponse.json({ error: "Invalid stateKey" }, { status: 400 });
  }
  return null;
}

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ stateKey: string }>;
}>(
  {
    routeId: "ai.threads.load",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    try {
      if (!context) throw new Error("context required for dynamic routes");
      const { stateKey } = await context.params;
      const input = loadThreadOperation.input.parse({ stateKey });

      if (!sessionUser) throw new Error("sessionUser required");

      const result = await loadThreadFacade({
        sessionUser,
        stateKey: input.stateKey,
      });

      return NextResponse.json(loadThreadOperation.output.parse(result), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error;
    }
  }
);

export const DELETE = wrapRouteHandlerWithLogging<{
  params: Promise<{ stateKey: string }>;
}>(
  {
    routeId: "ai.threads.delete",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    try {
      if (!context) throw new Error("context required for dynamic routes");
      const { stateKey } = await context.params;
      const input = deleteThreadOperation.input.parse({ stateKey });

      if (!sessionUser) throw new Error("sessionUser required");

      const result = await deleteThreadFacade({
        sessionUser,
        stateKey: input.stateKey,
      });

      return NextResponse.json(deleteThreadOperation.output.parse(result));
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error;
    }
  }
);
