// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/pr`
 * Purpose: Link branch/PR metadata to the authenticated principal's active work-item session.
 * Scope: HTTP parsing/auth/logging only. Delegates durable work-item patching to facade.
 * Invariants: AUTHENTICATED_PRINCIPAL, CONTRACTS_ARE_TRUTH, DURABLE_PR_LINK_ON_WORK_ITEM.
 *   A durable agent links only its own principal claim and stays AI-attributed;
 *   it is never projected into a users.id.
 * Side-effects: IO (HTTP response, DB/Doltgres through facade).
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007
 * @public
 */

import type { RequestPrincipal } from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { NextResponse } from "next/server";

import {
  linkWorkItemSessionPr,
  linkWorkItemSessionPrAsPrincipal,
} from "@/app/_facades/work/coordination.server";
import {
  RequestIdentityUnavailableError,
  resolveRequestPrincipal,
} from "@/app/_lib/auth/request-identity";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { workItemSessionPrOperation } from "@/contracts/work-item-sessions.v1.contract";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function coordinationUrl(request: Request, id: string): string {
  return new URL(`/api/v1/work/items/${id}/coordination`, request.url).pathname;
}

function compatibilitySessionUser(
  principal: Exclude<RequestPrincipal, { kind: "agent" }>
): SessionUser {
  return principal.kind === "human"
    ? {
        id: principal.userId,
        walletAddress: principal.walletAddress,
        displayName: principal.displayName,
        avatarColor: principal.avatarColor,
      }
    : {
        id: principal.legacyUserId,
        walletAddress: null,
        displayName: principal.displayName,
        avatarColor: null,
      };
}

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "work.items.sessions.pr",
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
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const parsed = workItemSessionPrOperation.input.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    try {
      const output =
        principal.kind === "agent"
          ? await linkWorkItemSessionPrAsPrincipal({
              workItemId: id,
              body: parsed.data,
              principal,
              statusUrl: coordinationUrl(request, id),
            })
          : await linkWorkItemSessionPr({
              workItemId: id,
              body: parsed.data,
              sessionUser: compatibilitySessionUser(principal),
              statusUrl: coordinationUrl(request, id),
            });
      ctx.log.info(
        {
          workItemId: id,
          coordinationId: output.session.coordinationId,
          principalKind: principal.kind,
          branch: output.session.branch,
          prNumber: output.session.prNumber,
        },
        "dev_coordination.pr_linked"
      );
      return NextResponse.json(workItemSessionPrOperation.output.parse(output));
    } catch (error) {
      if ((error as Error)?.name === "CoordinationWorkItemNotFoundError") {
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 404 }
        );
      }
      if ((error as Error)?.name === "WorkItemSessionForbiddenError") {
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 403 }
        );
      }
      if ((error as Error)?.name === "WorkItemSessionNotFoundError") {
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 404 }
        );
      }
      throw error;
    }
  }
);
