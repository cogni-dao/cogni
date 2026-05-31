// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/schedules`
 * Purpose: HTTP endpoints for schedule collection (create, list).
 * Scope: Auth-protected POST/GET endpoints for schedule management. Does not contain business logic.
 * Invariants:
 *   - Schedule ownership scoped to caller's billing account
 *   - SCHEDULE_CREATION_REJECTS_IF_CURRENTLY_UNPAYABLE: paid model + balance <= 0 → 402
 *   - createSchedule is atomic (grant + schedule + job enqueue)
 * Side-effects: IO (HTTP request/response, database, job queue)
 * Links: docs/spec/scheduler.md, schedules.*.v1.contract
 * @public
 */

import { toUserId } from "@cogni/ids";
import {
  ScheduleResponseSchema,
  schedulesCreateOperation,
  schedulesListOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  InvalidCronExpressionError,
  InvalidTimezoneError,
} from "@/ports/server";
import { getNodeId } from "@/shared/config";
// Credit gating removed — handled at execution time via PreflightCreditCheckDecorator
import { logRequestWarn, type RequestContext } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Maps a ScheduleSpec to wire format.
 */
function toResponse(spec: {
  id: string;
  graphId: string;
  input: unknown;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: spec.id,
    graphId: spec.graphId,
    input: spec.input as Record<string, unknown>,
    cron: spec.cron,
    timezone: spec.timezone,
    enabled: spec.enabled,
    nextRunAt: spec.nextRunAt?.toISOString() ?? null,
    lastRunAt: spec.lastRunAt?.toISOString() ?? null,
    createdAt: spec.createdAt.toISOString(),
    updatedAt: spec.updatedAt.toISOString(),
  };
}

/**
 * Local error handler for schedule routes.
 */
function handleRouteError(
  ctx: RequestContext,
  error: unknown
): NextResponse | null {
  // Zod validation errors
  if (error && typeof error === "object" && "issues" in error) {
    logRequestWarn(ctx.log, error, "VALIDATION_ERROR");
    return NextResponse.json(
      { error: "Invalid input format" },
      { status: 400 }
    );
  }

  // Invalid cron expression
  if (error instanceof InvalidCronExpressionError) {
    logRequestWarn(ctx.log, error, "INVALID_CRON");
    return NextResponse.json(
      { error: `Invalid cron expression: ${error.message}` },
      { status: 400 }
    );
  }

  // Invalid timezone
  if (error instanceof InvalidTimezoneError) {
    logRequestWarn(ctx.log, error, "INVALID_TIMEZONE");
    return NextResponse.json(
      { error: `Invalid timezone: ${error.message}` },
      { status: 400 }
    );
  }

  return null;
}

/**
 * POST /api/v1/schedules - Create a new schedule.
 */
export const POST = wrapRouteHandlerWithLogging(
  { routeId: "schedules.create", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    try {
      // Parse JSON body
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json(
          { error: "Invalid JSON body" },
          { status: 400 }
        );
      }

      // Validate with contract
      const input = schedulesCreateOperation.input.parse(body);

      if (!sessionUser) throw new Error("sessionUser required");

      const container = getContainer();

      // Get billing account for user
      const accountService = container.accountsForUser(
        toUserId(sessionUser.id)
      );
      const account = await accountService.getOrCreateBillingAccountForUser({
        userId: sessionUser.id,
      });

      // Credit gating removed from schedule creation — handled at execution time
      // via PreflightCreditCheckDecorator (same path as chat). Single authority.

      // Create schedule
      const schedule = await container.scheduleManager.createSchedule(
        toUserId(sessionUser.id),
        account.id,
        {
          nodeId: getNodeId(),
          graphId: input.graphId,
          input: input.input,
          cron: input.cron,
          timezone: input.timezone,
        }
      );

      ctx.log.info(
        { scheduleId: schedule.id, graphId: input.graphId },
        "schedules.create_success"
      );

      // Validate output and return
      return NextResponse.json(
        ScheduleResponseSchema.parse(toResponse(schedule)),
        { status: 201 }
      );
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error;
    }
  }
);

/**
 * GET /api/v1/schedules - List user's schedules.
 */
export const GET = wrapRouteHandlerWithLogging(
  { routeId: "schedules.list", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser) => {
    try {
      if (!sessionUser) throw new Error("sessionUser required");

      const container = getContainer();
      const schedules = await container.scheduleManager.listSchedules(
        toUserId(sessionUser.id)
      );

      ctx.log.info({ count: schedules.length }, "schedules.list_success");

      // Validate output and return
      return NextResponse.json(
        schedulesListOperation.output.parse({
          schedules: schedules.map(toResponse),
        })
      );
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error;
    }
  }
);
