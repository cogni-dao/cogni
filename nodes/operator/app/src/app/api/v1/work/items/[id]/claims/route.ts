// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/claims`
 * Purpose: Claim an operator work-item execution session for the authenticated user.
 * Scope: HTTP parsing/auth/logging only. Delegates coordination to facade.
 * Invariants: AUTH_REQUIRED, CONTRACTS_ARE_TRUTH, DOLT_IS_SOURCE_OF_TRUTH.
 * Side-effects: IO (HTTP response, DB through facade).
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007
 * @public
 */

import { NextResponse } from "next/server";

import { claimWorkItemSession } from "@/app/_facades/work/coordination.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { workItemSessionClaimOperation } from "@/contracts/work-item-sessions.v1.contract";

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
    routeId: "work.items.sessions.claim",
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
        operation: "claim",
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
      body = {};
    }

    const parsed = workItemSessionClaimOperation.input.safeParse(body);
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
      const output = await claimWorkItemSession({
        workItemId: id,
        body: parsed.data,
        sessionUser,
        statusUrl: coordinationUrl(request, id),
      });
      const status = output.conflict ? 200 : 201;
      const response = NextResponse.json(
        workItemSessionClaimOperation.output.parse(output),
        { status }
      );
      logTerminal({
        outcome: "success",
        status,
        result: output.conflict ? "conflict" : "claimed",
        ...(output.claimKind !== undefined && {
          claimKind: output.claimKind,
        }),
      });
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
