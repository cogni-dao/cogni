// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/heartbeat`
 * Purpose: Refresh the authenticated user's active work-item execution session.
 * Scope: HTTP parsing/auth/logging only. Delegates coordination to facade.
 * Invariants: AUTH_REQUIRED, CONTRACTS_ARE_TRUTH.
 * Side-effects: IO (HTTP response, DB through facade).
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007
 * @public
 */

import { NextResponse } from "next/server";

import { heartbeatWorkItemSession } from "@/app/_facades/work/coordination.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { workItemSessionHeartbeatOperation } from "@/contracts/work-item-sessions.v1.contract";

import { logWorkItemSessionComplete } from "../../_session-log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function coordinationUrl(request: Request, id: string): string {
  return new URL(`/api/v1/work/items/${id}/coordination`, request.url).pathname;
}

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "work.items.sessions.heartbeat",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    const startedAt = performance.now();
    const logTerminal = (
      fields: Omit<
        Parameters<typeof logWorkItemSessionComplete>[2],
        "operation"
      >
    ): void =>
      logWorkItemSessionComplete(ctx, startedAt, {
        operation: "heartbeat",
        ...fields,
      });
    if (!context) {
      logTerminal({
        outcome: "error",
        status: 500,
        errorCode: "internal_error",
      });
      throw new Error("context required for dynamic routes");
    }
    if (!sessionUser) {
      logTerminal({
        outcome: "error",
        status: 401,
        errorCode: "auth_required",
      });
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const parsed = workItemSessionHeartbeatOperation.input.safeParse(body);
    if (!parsed.success) {
      logTerminal({
        outcome: "error",
        status: 400,
        errorCode: "validation_error",
      });
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    try {
      const output = await heartbeatWorkItemSession({
        workItemId: id,
        body: parsed.data,
        sessionUser,
        statusUrl: coordinationUrl(request, id),
      });
      logTerminal({ outcome: "success", status: 200 });
      return NextResponse.json(
        workItemSessionHeartbeatOperation.output.parse(output)
      );
    } catch (error) {
      if ((error as Error)?.name === "CoordinationWorkItemNotFoundError") {
        logTerminal({
          outcome: "error",
          status: 404,
          errorCode: "work_item_not_found",
        });
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 404 }
        );
      }
      if ((error as Error)?.name === "WorkItemSessionForbiddenError") {
        logTerminal({
          outcome: "error",
          status: 403,
          errorCode: "session_owned_by_other",
        });
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 403 }
        );
      }
      if ((error as Error)?.name === "WorkItemSessionNotFoundError") {
        logTerminal({
          outcome: "error",
          status: 404,
          errorCode: "session_expired_or_missing",
        });
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 404 }
        );
      }
      logTerminal({
        outcome: "error",
        status: 500,
        errorCode: "internal_error",
      });
      throw error;
    }
  }
);
