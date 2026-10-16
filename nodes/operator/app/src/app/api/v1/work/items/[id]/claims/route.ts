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

import type { RequestPrincipal } from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { NextResponse } from "next/server";

import {
  claimWorkItemAsPrincipal,
  claimWorkItemSession,
} from "@/app/_facades/work/coordination.server";
import {
  RequestIdentityUnavailableError,
  resolveRequestPrincipal,
} from "@/app/_lib/auth/request-identity";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { workItemSessionClaimOperation } from "@/contracts/work-item-sessions.v1.contract";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

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
    routeId: "work.items.sessions.claim",
    auth: { mode: "none" },
  },
  async (ctx, request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    let principal: RequestPrincipal | null;
    try {
      principal = await resolveRequestPrincipal();
    } catch (error) {
      if (error instanceof RequestIdentityUnavailableError) {
        return NextResponse.json(
          { error: "identity service unavailable" },
          { status: 503 }
        );
      }
      throw error;
    }
    if (!principal) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    try {
      const sessionUser = compatibilitySessionUser(principal);
      const output =
        principal.kind === "agent"
          ? await claimWorkItemAsPrincipal({
              workItemId: id,
              body: parsed.data,
              principal,
              statusUrl: coordinationUrl(request, id),
            })
          : await claimWorkItemSession({
              workItemId: id,
              body: parsed.data,
              sessionUser,
              statusUrl: coordinationUrl(request, id),
            });
      ctx.log.info(
        {
          workItemId: id,
          coordinationId: output.session.coordinationId,
          actorPrincipalId: principal.principalId,
          conflict: output.conflict,
        },
        output.conflict
          ? "dev_coordination.claim_conflict"
          : "dev_coordination.claimed"
      );
      logEvent(ctx.log, EVENT_NAMES.WORK_ITEM_PRINCIPAL_OPERATION_COMPLETE, {
        reqId: ctx.reqId,
        operation: "claim",
        outcome: "success",
        workItemId: id,
        actorPrincipalId: principal.principalId,
        coordinationId: output.session.coordinationId,
      });
      return NextResponse.json(
        workItemSessionClaimOperation.output.parse(output),
        { status: output.conflict ? 200 : 201 }
      );
    } catch (error) {
      const errorName = (error as Error)?.name;
      if (errorName === "WorkItemSessionConflictError") {
        logEvent(ctx.log, EVENT_NAMES.WORK_ITEM_PRINCIPAL_OPERATION_COMPLETE, {
          reqId: ctx.reqId,
          operation: "claim",
          outcome: "conflict",
          workItemId: id,
          actorPrincipalId: principal.principalId,
        });
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 409 }
        );
      }
      if (errorName === "WorkItemSessionForbiddenError") {
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 403 }
        );
      }
      if ((error as Error)?.name === "CoordinationWorkItemNotFoundError") {
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 404 }
        );
      }
      throw error;
    }
  }
);
