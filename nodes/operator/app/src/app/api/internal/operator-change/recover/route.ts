// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/internal/operator-change/recover`
 * Purpose: Scheduler-authenticated delegation endpoint for one recovery Activity attempt.
 * Scope: Strict auth/input/output shell only; no GitHub credentials cross this boundary.
 * Invariants: Semantic outcomes are HTTP 200; thrown transport/ambiguous failures are retryable 503.
 * Side-effects: Delegates to the injected VCS capability.
 * Links: task.5188
 * @internal
 */

import { OperatorChangeRecoveryRequestSchema } from "@cogni/node-contracts";
import { verifySchedulerBearer } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { recoverOperatorChange } from "@/app/_facades/deploy/operator-change-recovery.server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "operator-change.recover.internal", auth: { mode: "none" } },
  async (ctx, request) => {
    if (
      !verifySchedulerBearer(
        request.headers.get("authorization"),
        serverEnv().SCHEDULER_API_TOKEN
      )
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = OperatorChangeRecoveryRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.issues },
        { status: 400 }
      );
    }
    try {
      const result = await recoverOperatorChange(
        parsed.data,
        getContainer().vcsCapability
      );
      return NextResponse.json(result, { status: 200 });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if ([400, 401, 403, 409, 422].includes(status ?? 0)) {
        return NextResponse.json(
          { status: "terminal", reason: `github-permanent-${status}` },
          { status: 200 }
        );
      }
      ctx.log.error(
        { error: String(error), losingHeadSha: parsed.data.losingHeadSha },
        "operator-change recovery attempt failed"
      );
      return NextResponse.json(
        { error: "Recovery temporarily unavailable" },
        { status: 503 }
      );
    }
  }
);
