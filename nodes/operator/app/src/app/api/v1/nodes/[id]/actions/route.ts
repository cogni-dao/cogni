// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Authenticated OpenFGA-gated gateway for allowlisted node-owned actions. */

import { NodeActionDispatchRequestSchema } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import {
  DispatchNodeActionError,
  type DispatchNodeActionErrorCode,
  dispatchNodeAction,
} from "@/app/_facades/nodes/node-action.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ERROR_STATUS: Record<DispatchNodeActionErrorCode, number> = {
  node_not_found: 404,
  node_action_unavailable: 503,
  unsupported_action: 400,
  request_too_large: 413,
  authz_denied: 403,
  authz_unavailable: 503,
  node_unavailable: 502,
  invalid_node_response: 502,
};

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "nodes.actions",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const parsed = NodeActionDispatchRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const { id } = await context.params;
    try {
      const response = await dispatchNodeAction({
        id,
        userId: sessionUser.id,
        request: parsed.data,
      });
      ctx.log.info(
        { nodeRef: id, action: parsed.data.action, status: response.status },
        "node.actions.dispatched"
      );
      return NextResponse.json(response.body, { status: response.status });
    } catch (error) {
      if (error instanceof DispatchNodeActionError) {
        return NextResponse.json(
          { error: error.code },
          { status: ERROR_STATUS[error.code] }
        );
      }
      throw error;
    }
  }
);
