// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/goals/route`
 * Purpose: The goal-loop START surface — `POST /api/v1/goals` files a
 *   `metric:judge` hypothesis on main and starts `GoalLoopWorkflow` for it. A
 *   goal is a `hypothesis` row with `resolution_strategy='metric:judge'`; the
 *   loop drives toward `judge >= target` until proven or budget-exhausted, then
 *   files a validates|invalidates outcome.
 * Scope: Auth + validation + dispatch only. The set-goal I/O lives in
 *   `_facades/goal-loop/start.server`; the per-tick loop runs in the workflow.
 * Invariants:
 *   - AUTH_VIA_GETSESSIONUSER: gated like `core__edo_*` — a bearer cogni key or
 *     a session cookie. Internal control plane, trusted-principal v0.
 *   - GOAL_ON_MAIN: the facade files via `edoCapability` (direct-to-main) so the
 *     workflow can load the row immediately.
 * Side-effects: IO (Doltgres write; starts a Temporal workflow)
 * Links: docs/design/knowledge-goal-loop.md § MVP checklist (Start surface)
 * @public
 */

import {
  DomainNotRegisteredError,
  HypothesisMissingEvaluateAtError,
} from "@cogni/knowledge-store";
import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { startGoal } from "@/app/_facades/goal-loop/start.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer, getTemporalWorkflowClient } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config/repoSpec.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BudgetSchema = z
  .object({
    maxIterations: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    maxRecursionDepth: z.number().int().min(0),
    maxStalledIterations: z.number().int().positive(),
  })
  .partial();

const StartGoalRequestSchema = z
  .object({
    /** The goal statement (the hypothesis content). */
    statement: z.string().min(1),
    /** The prose success criterion the independent judge scores evidence against. */
    criterion: z.string().min(1),
    /** Registered knowledge domain (e.g. `oss-ai`). */
    domain: z.string().min(1),
    /** Success threshold 0–100 (default 80). */
    target: z.number().min(0).max(100).optional(),
    /** Partial budget overrides over DEFAULT_LOOP_BUDGET. */
    budget: BudgetSchema.optional(),
    /** Graph the per-tick step runs (default `langgraph:research`). */
    stepGraphId: z
      .string()
      .regex(/^[a-z0-9_-]+:[a-z0-9_-]+$/)
      .optional(),
    /** ISO hard wall-clock stop (default now + 24h). */
    evaluateAt: z.string().datetime().optional(),
  })
  .strict();

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "goals.start", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
    const parsed = StartGoalRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const container = getContainer();
    const { client: workflowClient, taskQueue } =
      await getTemporalWorkflowClient();

    try {
      const result = await startGoal(
        {
          edo: container.edoCapability,
          workflowClient,
          taskQueue,
          nodeId: getNodeId(),
          now: () => new Date(container.clock.now()),
          log: ctx.log,
        },
        {
          statement: parsed.data.statement,
          criterion: parsed.data.criterion,
          domain: parsed.data.domain,
          ...(parsed.data.target !== undefined
            ? { target: parsed.data.target }
            : {}),
          ...(parsed.data.budget !== undefined
            ? { budget: parsed.data.budget }
            : {}),
          ...(parsed.data.stepGraphId !== undefined
            ? { stepGraphId: parsed.data.stepGraphId }
            : {}),
          ...(parsed.data.evaluateAt !== undefined
            ? { evaluateAt: new Date(parsed.data.evaluateAt) }
            : {}),
        }
      );
      return NextResponse.json(result, { status: 201 });
    } catch (e) {
      if (e instanceof DomainNotRegisteredError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      if (e instanceof HypothesisMissingEvaluateAtError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      if (e instanceof ZodError) {
        return NextResponse.json(
          { error: "invalid workflow input", issues: e.issues },
          { status: 400 }
        );
      }
      ctx.log.error({ err: String(e) }, "goals.start failed");
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "internal error" },
        { status: 500 }
      );
    }
  }
);
