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
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "operator-change.recover.internal", auth: { mode: "none" } },
  async (ctx, request) => {
    const env = serverEnv();
    if (
      !verifySchedulerBearer(
        request.headers.get("authorization"),
        env.SCHEDULER_API_TOKEN
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
        getContainer().vcsCapability,
        createOperatorDeployPlane(env)
      );
      return NextResponse.json(result, { status: 200 });
    } catch (error) {
      const status = (error as { status?: number }).status;
      const code = (error as { code?: string }).code;
      // An exact node.register head and signed source necessarily contain these objects. Immediately
      // after the ref CAS, GitHub reads may still report them absent; keep only these coded
      // availability races retryable. Identity, shape, and permission failures remain terminal.
      const registerAvailabilityRace =
        parsed.data.intent.operation === "node.register" &&
        ((status === 404 && code === "catalog_missing") ||
          (status === 422 &&
            (code === "source_missing" || code === "repo_spec_missing")));
      if (
        !registerAvailabilityRace &&
        typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429
      ) {
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
