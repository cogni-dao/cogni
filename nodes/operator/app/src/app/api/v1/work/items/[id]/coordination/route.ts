// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/coordination`
 * Purpose: Read current operator work-item coordination state.
 * Scope: HTTP parsing/auth/logging only. Delegates coordination to facade.
 * Invariants: AUTH_REQUIRED, CONTRACTS_ARE_TRUTH.
 * Side-effects: IO (HTTP response, DB through facade).
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007
 * @public
 */

import { NextResponse } from "next/server";

import { getWorkItemCoordination } from "@/app/_facades/work/coordination.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { workItemSessionCoordinationOperation } from "@/contracts/work-item-sessions.v1.contract";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function coordinationUrl(request: Request, id: string): string {
  return new URL(`/api/v1/work/items/${id}/coordination`, request.url).pathname;
}

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "work.items.sessions.coordination",
    getRequestDependencies: async () => {
      const { getRequestLoggingDependencies } = await import(
        "@/bootstrap/container"
      );
      return getRequestLoggingDependencies();
    },
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    try {
      const output = await getWorkItemCoordination({
        workItemId: id,
        statusUrl: coordinationUrl(request, id),
      });
      return NextResponse.json(
        workItemSessionCoordinationOperation.output.parse(output)
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
