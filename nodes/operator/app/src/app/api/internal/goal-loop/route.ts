// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/internal/goal-loop/route`
 * Purpose: Internal API the `GoalLoopWorkflow` activities call. One POST,
 *   dispatched by `op`: `load` (project the goal row → Goal + budget), `read-kpi`
 *   (verifier-independent KPI read), `step` (file ONE `evidence_for` atom), and
 *   `outcome` (file the closing validates|invalidates). The worker holds no DB
 *   creds (SHARED_COMPUTE_HOLDS_NO_DB_CREDS) — it HTTP-delegates here, like the
 *   scheduler's graph-run internal route.
 * Scope: Auth + dispatch only. The pure loop control lives in the workflow; the
 *   I/O lives in `_facades/goal-loop/service.server`.
 * Invariants:
 *   - INTERNAL_API_SHARED_SECRET: requires Bearer SCHEDULER_API_TOKEN (the same
 *     token the worker already carries for the graph-run internal route).
 *   - KPI_VERIFIER_INDEPENDENT: `read-kpi` resolves through the independent
 *     `metric:judge` reader in the service, never `recomputeConfidence`.
 *   - ACTIVITY_IDEMPOTENCY: `step` keys the atom on `${hypothesisId}/${iteration}`;
 *     `outcome` keys on `${hypothesisId}` — retries are no-ops.
 * Side-effects: IO (HTTP request/response, Doltgres read/write)
 * Links: docs/design/knowledge-goal-loop.md § Pareto MVP
 * @internal
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  fileGoalOutcome,
  type GoalLoopDeps,
  loadGoal,
  readGoalKpi,
  runGoalStep,
} from "@/app/_facades/goal-loop/service.server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_AUTH_HEADER_LENGTH = 512;

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader || authHeader.length > MAX_AUTH_HEADER_LENGTH) return null;
  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  return trimmed.slice(7).trim();
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const RequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("load"), hypothesisId: z.string().min(1) }),
  z.object({ op: z.literal("read-kpi"), hypothesisId: z.string().min(1) }),
  z.object({
    op: z.literal("step"),
    hypothesisId: z.string().min(1),
    domain: z.string().min(1),
    idempotencyKey: z.string().min(1),
    iteration: z.number().int().min(0),
    stepGraphId: z.string().min(1),
  }),
  z.object({
    op: z.literal("outcome"),
    hypothesisId: z.string().min(1),
    domain: z.string().min(1),
    edge: z.enum(["validates", "invalidates"]),
    reason: z.string().min(1),
    lastKpi: z.number(),
    target: z.number(),
  }),
]);

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "goal-loop.internal", auth: { mode: "none" } },
  async (ctx, request) => {
    const env = serverEnv();
    const log = ctx.log;

    const configured = env.SCHEDULER_API_TOKEN;
    if (!configured) {
      log.error("SCHEDULER_API_TOKEN not configured");
      return NextResponse.json(
        { error: "Service not configured" },
        { status: 500 }
      );
    }
    const provided = extractBearer(request.headers.get("authorization"));
    if (!provided || !safeCompare(provided, configured)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const container = getContainer();
    if (!container.knowledgeStorePort) {
      return NextResponse.json(
        { error: "Knowledge store not configured (DOLTGRES_URL not set)" },
        { status: 503 }
      );
    }
    const deps: GoalLoopDeps = {
      store: container.knowledgeStorePort,
      edo: container.edoCapability,
      now: () => new Date(container.clock.now()),
    };

    const op = parsed.data;
    try {
      switch (op.op) {
        case "load": {
          const loaded = await loadGoal(deps, op.hypothesisId);
          if (loaded === null) {
            return NextResponse.json({ goal: null }, { status: 200 });
          }
          return NextResponse.json(
            {
              goal: {
                hypothesisId: loaded.goal.hypothesisId,
                domain: loaded.goal.domain,
                kpiId: loaded.goal.kpiId,
                target: loaded.goal.target,
                evaluateAt: loaded.goal.evaluateAt.toISOString(),
              },
              budget: loaded.budget,
              stepGraphId: loaded.stepGraphId,
              nowIso: loaded.nowIso,
            },
            { status: 200 }
          );
        }
        case "read-kpi": {
          const kpi = await readGoalKpi(deps, op.hypothesisId);
          return NextResponse.json({ kpi }, { status: 200 });
        }
        case "step": {
          const result = await runGoalStep(deps, {
            hypothesisId: op.hypothesisId,
            domain: op.domain,
            idempotencyKey: op.idempotencyKey,
            iteration: op.iteration,
            stepGraphId: op.stepGraphId,
          });
          return NextResponse.json(result, { status: 200 });
        }
        case "outcome": {
          await fileGoalOutcome(deps, {
            hypothesisId: op.hypothesisId,
            domain: op.domain,
            edge: op.edge,
            reason: op.reason,
            lastKpi: op.lastKpi,
            target: op.target,
          });
          return NextResponse.json({ ok: true }, { status: 200 });
        }
      }
    } catch (e) {
      log.error(
        { op: op.op, hypothesisId: op.hypothesisId, err: String(e) },
        "goal-loop.internal op failed"
      );
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "internal error" },
        { status: 500 }
      );
    }
  }
);
