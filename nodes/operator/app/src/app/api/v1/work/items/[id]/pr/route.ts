// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/pr`
 * Purpose: Link branch/PR metadata to the authenticated user's active work-item session.
 * Scope: HTTP parsing/auth/logging only. Delegates durable work-item patching to facade.
 * Invariants: AUTH_REQUIRED, CONTRACTS_ARE_TRUTH, DURABLE_PR_LINK_ON_WORK_ITEM.
 * Side-effects: IO (HTTP response, DB/Doltgres through facade).
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007
 * @public
 */

import { NextResponse } from "next/server";

import { linkWorkItemSessionPr } from "@/app/_facades/work/coordination.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { workItemSessionPrOperation } from "@/contracts/work-item-sessions.v1.contract";

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
    routeId: "work.items.sessions.pr",
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
        operation: "link_pr",
        ...fields,
      });
    if (!context) {
      const response = NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
      logTerminal({
        outcome: "error",
        status: 500,
        errorCode: "internal_error",
      });
      return response;
    }
    if (!sessionUser) {
      const response = NextResponse.json(
        { error: "unauthorized" },
        { status: 401 }
      );
      logTerminal({
        outcome: "error",
        status: 401,
        errorCode: "auth_required",
      });
      return response;
    }
    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      const response = NextResponse.json(
        { error: "invalid JSON body" },
        { status: 400 }
      );
      logTerminal({
        outcome: "error",
        status: 400,
        errorCode: "validation_error",
      });
      return response;
    }

    const parsed = workItemSessionPrOperation.input.safeParse(body);
    if (!parsed.success) {
      const response = NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
      logTerminal({
        outcome: "error",
        status: 400,
        errorCode: "validation_error",
      });
      return response;
    }

    try {
      const output = await linkWorkItemSessionPr({
        workItemId: id,
        body: parsed.data,
        sessionUser,
        statusUrl: coordinationUrl(request, id),
      });
      const response = NextResponse.json(
        workItemSessionPrOperation.output.parse(output)
      );
      logTerminal({ outcome: "success", status: 200 });
      return response;
    } catch (error) {
      if ((error as Error)?.name === "CoordinationWorkItemNotFoundError") {
        const response = NextResponse.json(
          { error: (error as Error).message },
          { status: 404 }
        );
        logTerminal({
          outcome: "error",
          status: 404,
          errorCode: "work_item_not_found",
        });
        return response;
      }
      if ((error as Error)?.name === "WorkItemSessionForbiddenError") {
        const response = NextResponse.json(
          { error: (error as Error).message },
          { status: 403 }
        );
        logTerminal({
          outcome: "error",
          status: 403,
          errorCode: "session_owned_by_other",
        });
        return response;
      }
      if ((error as Error)?.name === "WorkItemSessionNotFoundError") {
        const response = NextResponse.json(
          { error: (error as Error).message },
          { status: 404 }
        );
        logTerminal({
          outcome: "error",
          status: 404,
          errorCode: "session_expired_or_missing",
        });
        return response;
      }
      const response = NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
      logTerminal({
        outcome: "error",
        status: 500,
        errorCode: "internal_error",
      });
      return response;
    }
  }
);
