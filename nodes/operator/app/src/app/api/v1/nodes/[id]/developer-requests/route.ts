// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/developer-requests`
 * Purpose: Agent-facing endpoint to request developer (flight) access to one node. Replaces the
 *   hacky "paste a fetch() into DevTools" handoff — an authenticated AI agent files a durable,
 *   idempotent request the node owner later approves in-UI.
 * Scope: Bearer/session caller requests access FOR ITSELF; agentUserId is the authenticated
 *   principal, never the body. Writes a tracking row only — OpenFGA tuples remain flight authority.
 * Invariants: AUTH_REQUIRED, SELF_REQUEST_ONLY, NOT_AUTHORITY, IDEMPOTENT_REOPEN.
 * Side-effects: IO (Postgres read + upsert)
 * Links: docs/spec/rbac.md §6, src/features/nodes/developer-requests.ts
 * @public
 */

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { upsertDeveloperRequest } from "@/features/nodes/developer-requests";
import { nodes } from "@/shared/db/nodes";
import {
  EVENT_NAMES,
  logEvent,
  type RequestContext,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DeveloperRequestInput = z
  .object({ scope: z.literal("flight").optional() })
  .optional();

interface RequestLogFields {
  readonly outcome: "success" | "error";
  readonly status: number;
  readonly nodeId: string;
  readonly agentUserId?: string | undefined;
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
  const payload = {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    durationMs: elapsedMs(startedAt),
    ...fields,
  };
  if (fields.outcome === "success") {
    logEvent(
      ctx.log,
      EVENT_NAMES.NODE_DEVELOPER_REQUEST_COMPLETE,
      payload,
      EVENT_NAMES.NODE_DEVELOPER_REQUEST_COMPLETE
    );
    return;
  }
  const level = fields.status >= 500 ? "error" : "warn";
  ctx.log[level](
    { event: EVENT_NAMES.NODE_DEVELOPER_REQUEST_COMPLETE, ...payload },
    EVENT_NAMES.NODE_DEVELOPER_REQUEST_COMPLETE
  );
}

export const POST = wrapRouteHandlerWithLogging<RouteParams>(
  {
    routeId: "nodes.developer-requests",
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
    const parsed = DeveloperRequestInput.safeParse(rawBody);
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

    const db = resolveServiceDb();
    const existing = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.id, id))
      .limit(1);
    if (!existing[0]) {
      logTerminal({
        outcome: "error",
        status: 404,
        nodeId: id,
        agentUserId: sessionUser.id,
        errorCode: "node_not_found",
      });
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    await upsertDeveloperRequest(db, {
      nodeId: id,
      agentUserId: sessionUser.id,
      scope: "flight",
    });

    logTerminal({
      outcome: "success",
      status: 201,
      nodeId: id,
      agentUserId: sessionUser.id,
    });
    return NextResponse.json(
      {
        nodeId: id,
        agentUserId: sessionUser.id,
        scope: "flight",
        status: "pending",
      },
      { status: 201 }
    );
  }
);
