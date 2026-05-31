// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/schedules/[scheduleId]`
 * Purpose: HTTP endpoints for single schedule operations (update, delete).
 * Scope: Auth-protected PATCH/DELETE endpoints for schedule management. Does not contain business logic.
 * Invariants:
 *   - Schedule ownership enforced (callerUserId must match ownerUserId)
 *   - Delete also revokes the associated grant
 * Side-effects: IO (HTTP request/response, database)
 * Links: docs/spec/scheduler.md, schedules.*.v1.contract
 * @public
 */

import { toUserId } from "@cogni/ids";
import {
  ScheduleResponseSchema,
  schedulesUpdateOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  InvalidCronExpressionError,
  InvalidTimezoneError,
  ScheduleAccessDeniedError,
  ScheduleNotFoundError,
} from "@/ports/server";
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

  // Schedule not found
  if (error instanceof ScheduleNotFoundError) {
    logRequestWarn(ctx.log, error, "SCHEDULE_NOT_FOUND");
    return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
  }

  // Access denied
  if (error instanceof ScheduleAccessDeniedError) {
    logRequestWarn(ctx.log, error, "SCHEDULE_ACCESS_DENIED");
    return NextResponse.json(
      { error: "Schedule not found" }, // Don't leak existence
      { status: 404 }
    );
  }

  return null;
}

/**
 * PATCH /api/v1/schedules/[scheduleId] - Update a schedule.
 */
export const PATCH = wrapRouteHandlerWithLogging<{
  params: Promise<{ scheduleId: string }>;
}>(
  { routeId: "schedules.update", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser, context) => {
    try {
      if (!context) throw new Error("context required for dynamic routes");
      const { scheduleId } = await context.params;

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
      const parsed = schedulesUpdateOperation.input.parse(body);

      if (!sessionUser) throw new Error("sessionUser required");

      const container = getContainer();

      // Explicit mapping at HTTP→port boundary (exactOptionalPropertyTypes safe)
      const patch = {
        ...(parsed.input !== undefined && { input: parsed.input }),
        ...(parsed.cron !== undefined && { cron: parsed.cron }),
        ...(parsed.timezone !== undefined && { timezone: parsed.timezone }),
        ...(parsed.enabled !== undefined && { enabled: parsed.enabled }),
      };

      // Update schedule
      const schedule = await container.scheduleManager.updateSchedule(
        toUserId(sessionUser.id),
        scheduleId,
        patch
      );

      ctx.log.info({ scheduleId: schedule.id }, "schedules.update_success");

      // Validate output and return
      return NextResponse.json(
        ScheduleResponseSchema.parse(toResponse(schedule))
      );
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error;
    }
  }
);

/**
 * DELETE /api/v1/schedules/[scheduleId] - Delete a schedule.
 */
export const DELETE = wrapRouteHandlerWithLogging<{
  params: Promise<{ scheduleId: string }>;
}>(
  { routeId: "schedules.delete", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser, context) => {
    try {
      if (!context) throw new Error("context required for dynamic routes");
      const { scheduleId } = await context.params;

      if (!sessionUser) throw new Error("sessionUser required");

      const container = getContainer();

      // Delete schedule (also revokes grant)
      await container.scheduleManager.deleteSchedule(
        toUserId(sessionUser.id),
        scheduleId
      );

      ctx.log.info({ scheduleId }, "schedules.delete_success");

      // Return 204 No Content
      return new NextResponse(null, { status: 204 });
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error;
    }
  }
);
