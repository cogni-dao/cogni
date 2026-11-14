// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/claims`
 * Purpose: Claim an operator work-item execution session for the authenticated user.
 * Scope: HTTP parsing/auth/logging only. Delegates coordination to facade.
 * Invariants: AUTH_REQUIRED, CONTRACTS_ARE_TRUTH, DOLT_IS_SOURCE_OF_TRUTH.
 * Side-effects: IO (HTTP response, DB through facade).
 * Links: https://cognidao.org/knowledge/validation-hold-design, task.5007
 * @public
 */

import { NextResponse } from "next/server";

import { claimWorkItemSession } from "@/app/_facades/work/coordination.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { workItemSessionClaimOperation } from "@/contracts/work-item-sessions.v1.contract";

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
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) {
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
      const output = await claimWorkItemSession({
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
          conflict: output.conflict,
        },
        output.conflict
          ? "dev_coordination.claim_conflict"
          : "dev_coordination.claimed"
      );
      return NextResponse.json(
        workItemSessionClaimOperation.output.parse(output),
        { status: output.conflict ? 200 : 201 }
      );
    } catch (error) {
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
