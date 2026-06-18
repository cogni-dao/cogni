// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/access-requests`
 * Purpose: Agent-facing endpoint to request access (a node role) for one node. Replaces the hacky
 *   "paste a fetch() into DevTools" handoff — an authenticated AI agent files a durable, idempotent
 *   request the node owner later approves in-UI.
 * Scope: Bearer/session caller requests access FOR ITSELF; agentUserId is the authenticated
 *   principal, never the body. `role` defaults to `developer` (v0). Writes a tracking row only —
 *   OpenFGA role tuples remain the authority.
 * Invariants: AUTH_REQUIRED, SELF_REQUEST_ONLY, NOT_AUTHORITY, IDEMPOTENT_REOPEN.
 * Side-effects: IO (Postgres read + upsert)
 * Links: docs/spec/rbac.md §6, src/features/nodes/access-requests.ts
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { upsertAccessRequest } from "@/features/nodes/access-requests";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import { NODE_ACCESS_ROLES } from "@/shared/db/node-access-requests";
import { nodes } from "@/shared/db/nodes";
import { EVENT_NAMES, type RequestContext } from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AccessRequestInput = z
  .object({ role: z.enum(NODE_ACCESS_ROLES).optional() })
  .optional();

interface RequestLogFields {
  readonly outcome: "success" | "error";
  readonly status: number;
  readonly nodeId: string;
  readonly agentUserId?: string | undefined;
  readonly role?: string | undefined;
  readonly errorCode?: string | undefined;
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function logRequestComplete(
  ctx: RequestContext,
  startedAt: number,
  fields: RequestLogFields
): void {
  // App-local event (not in the node-shared registry), so log via ctx.log directly —
  // matching how ADAPTER_GITHUB_REPO_WRITE_ERROR and other operator-local events are emitted.
  const payload = {
    event: EVENT_NAMES.NODE_ACCESS_REQUEST_COMPLETE,
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    durationMs: elapsedMs(startedAt),
    ...fields,
  };
  const level =
    fields.outcome === "success"
      ? "info"
      : fields.status >= 500
        ? "error"
        : "warn";
  ctx.log[level](payload, EVENT_NAMES.NODE_ACCESS_REQUEST_COMPLETE);
}

export const POST = wrapRouteHandlerWithLogging<RouteParams>(
  {
    routeId: "nodes.access-requests",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, routeCtx) => {
    const startedAt = performance.now();
    const { id } = await (routeCtx?.params ??
      Promise.resolve({ id: "unknown" }));
    const logTerminal = (fields: RequestLogFields): void =>
      logRequestComplete(ctx, startedAt, fields);

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      rawBody = undefined;
    }
    const parsed = AccessRequestInput.safeParse(rawBody);
    if (!parsed.success) {
      logTerminal({
        outcome: "error",
        status: 400,
        nodeId: id,
        agentUserId: sessionUser.id,
        errorCode: "validation_error",
      });
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const role = parsed.data?.role ?? "developer";

    const db = resolveServiceDb();
    const existing = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(nodeIdOrSlug(id))
      .limit(1);
    const node = existing[0];
    if (!node) {
      logTerminal({
        outcome: "error",
        status: 404,
        nodeId: id,
        agentUserId: sessionUser.id,
        role,
        errorCode: "node_not_found",
      });
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    // `{id}` may be a slug; the tracking FK is the canonical node identity (`nodes.id`).
    const nodeRowId = node.id;

    await upsertAccessRequest(db, {
      nodeId: nodeRowId,
      agentUserId: sessionUser.id,
      role,
    });

    logTerminal({
      outcome: "success",
      status: 201,
      nodeId: nodeRowId,
      agentUserId: sessionUser.id,
      role,
    });
    return NextResponse.json(
      {
        nodeId: nodeRowId,
        agentUserId: sessionUser.id,
        role,
        status: "pending",
      },
      { status: 201 }
    );
  }
);
