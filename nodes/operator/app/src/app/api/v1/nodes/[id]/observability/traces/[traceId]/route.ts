// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/observability/traces/[traceId]`
 * Purpose: Node-scoped Langfuse trace detail read proxy. A developer-RBAC'd dev reads one trace
 *   detail; the operator uses its own Langfuse key and returns content only after proving the trace
 *   belongs to the resolved node via tags and/or `metadata.nodeId`.
 * Scope: Thin shell — session auth, developer-RBAC gate (same `node.flight` tuple as trace list),
 *   resolve {slug|node_id} against the full registry, delegate to the Langfuse reader.
 * Invariants:
 *   - DEVELOPER_GATED (`node.flight`); fail-closed without a store.
 *   - NEVER_ISSUES_A_KEY: returns trace detail, never the Langfuse credential.
 *   - NODE_BOUNDARY_ENFORCED: boundary mismatch/missing attribution returns content-free 404.
 *   - TERMINAL_EVENT: one `feature.node_observability_traces.complete` per request. Never trace content.
 * Side-effects: IO (registry read, authz check, Langfuse query)
 * Links: ../route.ts, src/bootstrap/observability.factory.ts, src/ports/langfuse-reader.port.ts
 * @public
 */

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { createLangfuseReader } from "@/bootstrap/observability.factory";
import { getCurrentTraceId } from "@/bootstrap/otel";
import { resolveNodeRef } from "@/features/nodes/node-lookup";
import {
  createRequestContext,
  EVENT_NAMES,
  logEvent,
  makeLogger,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

interface RouteParams {
  params: Promise<{ id: string; traceId: string }>;
}

export async function GET(
  request: Request,
  ctx: RouteParams
): Promise<NextResponse> {
  const startedAt = performance.now();
  const reqCtx = createRequestContext({ baseLog, clock }, request, {
    routeId: "nodes.observability-trace-detail",
    traceId: getCurrentTraceId(),
    session: undefined,
  });

  const logComplete = (fields: {
    outcome: "success" | "error";
    status: number;
    errorCode?: string;
    nodeRef?: string;
    nodeId?: string;
  }): void => {
    const payload = {
      reqId: reqCtx.reqId,
      routeId: reqCtx.routeId,
      durationMs: Math.round(performance.now() - startedAt),
      read: "detail",
      ...fields,
    };
    if (fields.outcome === "success") {
      logEvent(
        reqCtx.log,
        EVENT_NAMES.NODE_OBSERVABILITY_TRACES_COMPLETE,
        payload,
        EVENT_NAMES.NODE_OBSERVABILITY_TRACES_COMPLETE
      );
      return;
    }
    const level = fields.status >= 500 ? "error" : "warn";
    reqCtx.log[level](
      { event: EVENT_NAMES.NODE_OBSERVABILITY_TRACES_COMPLETE, ...payload },
      EVENT_NAMES.NODE_OBSERVABILITY_TRACES_COMPLETE
    );
  };

  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    logComplete({ outcome: "error", status: 401, errorCode: "unauthorized" });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id, traceId } = await ctx.params;

  const node = await resolveNodeRef(resolveServiceDb(), id);
  if (!node) {
    logComplete({
      outcome: "error",
      status: 404,
      errorCode: "node_not_found",
      nodeRef: id,
    });
    return NextResponse.json({ error: "node_not_found" }, { status: 404 });
  }

  const authorization = getContainer().authorization;
  if (!authorization) {
    logComplete({
      outcome: "error",
      status: 503,
      errorCode: "authz_unavailable",
      nodeId: node.nodeId,
    });
    return NextResponse.json({ error: "authz_unavailable" }, { status: 503 });
  }
  const decision = await authorization.check({
    actorId: `user:${sessionUser.id}`,
    action: "node.flight",
    resource: `node:${node.nodeId}`,
    context: { tenantId: node.nodeId, nodeId: node.nodeId },
  });
  if (decision.decision !== "allow") {
    const code: AuthzDecisionCode = decision.code;
    const status = code === "authz_unavailable" ? 503 : 403;
    logComplete({
      outcome: "error",
      status,
      errorCode: code,
      nodeId: node.nodeId,
    });
    return NextResponse.json({ error: code }, { status });
  }

  const reader = createLangfuseReader();
  if (!reader) {
    logComplete({
      outcome: "error",
      status: 503,
      errorCode: "observability_unwired",
      nodeId: node.nodeId,
    });
    return NextResponse.json(
      {
        error: "observability_unwired",
        message:
          "operator holds no Langfuse key in this env — set " +
          "cogni/<env>/_shared/{LANGFUSE_BASE_URL,LANGFUSE_PUBLIC_KEY,LANGFUSE_SECRET_KEY} in OpenBao",
      },
      { status: 503 }
    );
  }

  try {
    const trace = await reader.getTrace({ nodeId: node.nodeId, traceId });
    if (!trace) {
      logComplete({
        outcome: "error",
        status: 404,
        errorCode: "trace_not_found",
        nodeId: node.nodeId,
      });
      return NextResponse.json({ error: "trace_not_found" }, { status: 404 });
    }

    logComplete({
      outcome: "success",
      status: 200,
      nodeId: node.nodeId,
    });
    return NextResponse.json({ nodeId: node.nodeId, trace });
  } catch (err) {
    reqCtx.log.error(
      { err, nodeId: node.nodeId },
      "langfuse trace detail read failed"
    );
    logComplete({
      outcome: "error",
      status: 502,
      errorCode: "observability_upstream_error",
      nodeId: node.nodeId,
    });
    return NextResponse.json(
      { error: "observability_upstream_error" },
      { status: 502 }
    );
  }
}
