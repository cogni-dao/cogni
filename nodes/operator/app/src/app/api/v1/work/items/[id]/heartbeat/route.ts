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

import type { RequestPrincipal } from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { NextResponse } from "next/server";

import {
  heartbeatWorkItemAsPrincipal,
  heartbeatWorkItemSession,
} from "@/app/_facades/work/coordination.server";
import {
  RequestIdentityUnavailableError,
  resolveRequestPrincipal,
} from "@/app/_lib/auth/request-identity";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { workItemSessionHeartbeatOperation } from "@/contracts/work-item-sessions.v1.contract";
import { workItemTerminal } from "../../_observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function coordinationUrl(request: Request, id: string): string {
  return new URL(`/api/v1/work/items/${id}/coordination`, request.url).pathname;
}

function compatibilitySessionUser(
  principal: RequestPrincipal
): SessionUser | null {
  if (principal.kind === "human") {
    return {
      id: principal.userId,
      walletAddress: principal.walletAddress,
      displayName: principal.displayName,
      avatarColor: principal.avatarColor,
    };
  }
  if (principal.kind === "legacy_agent") {
    return {
      id: principal.legacyUserId,
      walletAddress: null,
      displayName: principal.displayName,
      avatarColor: null,
    };
  }
  return null;
}

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "work.items.sessions.heartbeat",
    getRequestDependencies: async () => {
      const { getRequestLoggingDependencies } = await import(
        "@/bootstrap/container"
      );
      return getRequestLoggingDependencies();
    },
    auth: { mode: "none" },
  },
  async (ctx, request, _sessionUser, context) => {
    const terminal = workItemTerminal(ctx, performance.now(), "heartbeat");
    if (!context) {
      terminal.internalError();
      throw new Error("context required for dynamic routes");
    }
    let principal: RequestPrincipal | null;
    try {
      principal = await resolveRequestPrincipal();
    } catch (error) {
      if (error instanceof RequestIdentityUnavailableError) {
        terminal.complete({
          status: 503,
          outcome: "error",
          errorCode: "identity_unavailable",
          reasonCode: "identity_service_unavailable",
        });
        return NextResponse.json(
          { error: "identity service unavailable" },
          { status: 503 }
        );
      }
      terminal.internalError();
      throw error;
    }
    if (!principal) {
      terminal.complete({
        status: 401,
        outcome: "error",
        errorCode: "unauthorized",
        reasonCode: "principal_missing",
      });
      return NextResponse.json(
        { error: "unauthorized" },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
      );
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
      terminal.complete({
        status: 400,
        outcome: "error",
        errorCode: "invalid_input",
        reasonCode: "contract_validation_failed",
      });
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    try {
      const sessionUser = compatibilitySessionUser(principal);
      const output =
        principal.kind === "agent"
          ? await heartbeatWorkItemAsPrincipal({
              workItemId: id,
              body: parsed.data,
              principal,
              statusUrl: coordinationUrl(request, id),
            })
          : await heartbeatWorkItemSession({
              workItemId: id,
              body: parsed.data,
              sessionUser,
              statusUrl: coordinationUrl(request, id),
            });
      const responseBody =
        workItemSessionHeartbeatOperation.output.parse(output);
      terminal.complete({ status: 200, outcome: "success" });
      return NextResponse.json(responseBody);
    } catch (error) {
      if ((error as Error)?.name === "CoordinationWorkItemNotFoundError") {
        terminal.complete({
          status: 404,
          outcome: "error",
          errorCode: "not_found",
          reasonCode: "work_item_not_found",
        });
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 404 }
        );
      }
      if ((error as Error)?.name === "WorkItemSessionForbiddenError") {
        terminal.complete({
          status: 403,
          outcome: "error",
          errorCode: "forbidden",
          reasonCode: "session_forbidden",
        });
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 403 }
        );
      }
      if ((error as Error)?.name === "WorkItemSessionNotFoundError") {
        terminal.complete({
          status: 404,
          outcome: "error",
          errorCode: "session_not_found",
          reasonCode: "session_not_found",
        });
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 404 }
        );
      }
      terminal.internalError();
      throw error;
    }
  }
);
