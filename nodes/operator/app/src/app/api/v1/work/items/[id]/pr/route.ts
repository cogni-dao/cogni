// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/pr`
 * Purpose: Link branch/PR metadata to the authenticated user's active work-item session.
 * Scope: HTTP parsing/auth/logging only. Delegates durable work-item patching to facade.
 * Invariants: AUTH_REQUIRED, CONTRACTS_ARE_TRUTH, DURABLE_PR_LINK_ON_WORK_ITEM.
 * Side-effects: IO (HTTP response, DB/Doltgres through facade).
 * Links: https://cognidao.org/knowledge/validation-hold-design, task.5007
 * @public
 */

import { NextResponse } from "next/server";

import { linkWorkItemSessionPr } from "@/app/_facades/work/coordination.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { workItemSessionPrOperation } from "@/contracts/work-item-sessions.v1.contract";

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
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
      const output = await linkWorkItemSessionPr({
        workItemId: id,
        body: parsed.data,
        sessionUser,
        statusUrl: coordinationUrl(request, id),
      });
      ctx.log.info(
        {
          workItemId: id,
          coordinationId: output.session.coordinationId,
          claimedByUserId: sessionUser.id,
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
