// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/developers`
 * Purpose: Owner-gated approval surface for node developer flighting authority.
 * Scope: Browser-session owners approve/reject registered agent users for one node by writing/removing OpenFGA `developer` tuples.
 * Invariants: OWNER_GATING, OPENFGA_IS_AUTHORITY, NO_LOCAL_ROLE_TABLE.
 * Side-effects: IO (Postgres read, OpenFGA tuple write/delete)
 * Links: docs/spec/rbac.md, docs/spec/identity-model.md
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { users } from "@cogni/db-schema/refs";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  getContainer,
  resolveAppDb,
  resolveServiceDb,
} from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";
import { nodes } from "@/shared/db/nodes";
import {
  EVENT_NAMES,
  logEvent,
  type RequestContext,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DeveloperDecisionInput = z.object({
  agentUserId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
});

type DeveloperDecision = z.infer<typeof DeveloperDecisionInput>["decision"];

interface DeveloperDecisionLogFields {
  readonly outcome: "success" | "error";
  readonly status: number;
  readonly nodeId: string;
  readonly decision?: DeveloperDecision | undefined;
  readonly agentUserId?: string | undefined;
  readonly errorCode?: string | undefined;
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function logDeveloperDecisionComplete(
  ctx: RequestContext,
  startedAt: number,
  fields: DeveloperDecisionLogFields
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
      EVENT_NAMES.NODE_DEVELOPER_DECISION_COMPLETE,
      payload,
      EVENT_NAMES.NODE_DEVELOPER_DECISION_COMPLETE
    );
    return;
  }
  const level = fields.status >= 500 ? "error" : "warn";
  ctx.log[level](
    { event: EVENT_NAMES.NODE_DEVELOPER_DECISION_COMPLETE, ...payload },
    EVENT_NAMES.NODE_DEVELOPER_DECISION_COMPLETE
  );
}

export const POST = wrapRouteHandlerWithLogging<RouteParams>(
  {
    routeId: "nodes.developers",
    auth: { mode: "optional", getSessionUser: getServerSessionUser },
  },
  async (ctx, request, session, routeCtx) => {
    const startedAt = performance.now();
    const { id } = await (routeCtx?.params ??
      Promise.resolve({ id: "unknown" }));
    const logTerminal = (fields: DeveloperDecisionLogFields): void =>
      logDeveloperDecisionComplete(ctx, startedAt, fields);

    if (!session) {
      logTerminal({
        outcome: "error",
        status: 401,
        nodeId: id,
        errorCode: "unauthorized",
      });
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      logTerminal({
        outcome: "error",
        status: 400,
        nodeId: id,
        errorCode: "invalid_json",
      });
      return NextResponse.json({ error: "invalid json" }, { status: 400 });
    }

    const parsed = DeveloperDecisionInput.safeParse(body);
    if (!parsed.success) {
      logTerminal({
        outcome: "error",
        status: 400,
        nodeId: id,
        errorCode: "validation_error",
      });
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const db = resolveAppDb();
    const existing = await withTenantScope(
      db,
      userActor(session.id as UserId),
      async (tx) =>
        tx
          .select({ id: nodes.id })
          .from(nodes)
          .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
          .limit(1)
    );
    if (!existing[0]) {
      logTerminal({
        outcome: "error",
        status: 404,
        nodeId: id,
        decision: parsed.data.decision,
        agentUserId: parsed.data.agentUserId,
        errorCode: "node_not_found",
      });
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const serviceDb = resolveServiceDb();
    const agentUsers = await serviceDb
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, parsed.data.agentUserId))
      .limit(1);
    if (!agentUsers[0]) {
      logTerminal({
        outcome: "error",
        status: 404,
        nodeId: id,
        decision: parsed.data.decision,
        agentUserId: parsed.data.agentUserId,
        errorCode: "agent_user_not_found",
      });
      return NextResponse.json(
        { error: "agent user not found" },
        { status: 404 }
      );
    }

    const authorization = getContainer().authorization;
    if (!authorization) {
      logTerminal({
        outcome: "error",
        status: 503,
        nodeId: id,
        decision: parsed.data.decision,
        agentUserId: parsed.data.agentUserId,
        errorCode: "authz_unavailable",
      });
      return NextResponse.json(
        {
          error: "authorization not configured",
          errorCode: "authz_unavailable",
        },
        { status: 503 }
      );
    }

    const tuple = {
      user: `user:${parsed.data.agentUserId}`,
      relation: "developer",
      object: `node:${id}`,
    };
    const write =
      parsed.data.decision === "approve"
        ? await authorization.writeRelation(tuple)
        : await authorization.deleteRelation(tuple);

    if (write.decision !== "success") {
      logTerminal({
        outcome: "error",
        status: 503,
        nodeId: id,
        decision: parsed.data.decision,
        agentUserId: parsed.data.agentUserId,
        errorCode: write.code,
      });
      return NextResponse.json(
        {
          error: "authorization write unavailable",
          errorCode: write.code,
        },
        { status: 503 }
      );
    }

    logTerminal({
      outcome: "success",
      status: 200,
      nodeId: id,
      decision: parsed.data.decision,
      agentUserId: parsed.data.agentUserId,
    });
    return NextResponse.json({
      nodeId: id,
      agentUserId: parsed.data.agentUserId,
      decision: parsed.data.decision,
    });
  }
);
