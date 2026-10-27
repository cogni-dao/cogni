// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/observability/langfuse/api/public/v2/observations`
 * Purpose: Native Langfuse observation content with the same node developer gate as logs.
 * Scope: HTTP shell; delegates query and ownership policy to features/ports.
 * Invariants: Bearer-first identity; no shared Langfuse credential returned; one terminal event.
 * Side-effects: auth, registry and scoped backend reads
 * Links: contracts/nodes.langfuse.observations.v1.contract.ts, task.5319
 * @public
 */

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import {
  consumeTraceReadBudget,
  createLangfuseReader,
} from "@/bootstrap/observability.factory";
import { getCurrentTraceId } from "@/bootstrap/otel";
import { LangfuseObservationPageSchema } from "@/contracts/nodes.langfuse.observations.v1.contract";
import { resolveNodeRef } from "@/features/nodes/node-lookup";
import {
  parseTraceQuery,
  TraceQueryError,
} from "@/features/nodes/observability-traces";
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
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  ctx: RouteParams
): Promise<NextResponse> {
  const startedAt = performance.now();
  const reqCtx = createRequestContext({ baseLog, clock }, request, {
    routeId: "nodes.observability-langfuse-observations",
    traceId: getCurrentTraceId(),
    session: undefined,
  });

  // Single deterministic terminal event. Privacy: enums/ids/counts only — never trace content.
  const logComplete = (fields: {
    outcome: "success" | "error";
    status: number;
    errorCode?: string;
    nodeRef?: string;
    nodeId?: string;
    env?: string;
    count?: number;
  }): void => {
    const payload = {
      reqId: reqCtx.reqId,
      routeId: reqCtx.routeId,
      durationMs: Math.round(performance.now() - startedAt),
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

  const { id } = await ctx.params;

  // Resolve {id} (repo-spec node_id OR slug) against the FULL registry, any status (authz gates, not
  // status — a deployed node is `published`, never `active`). Service-role read (no RLS).
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

  // Developer-gated: the SAME `node.flight` tuple as flight + the logs proxy. Fail-closed (deny).
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

  let query: ReturnType<typeof parseTraceQuery>;
  try {
    query = parseTraceQuery(new URL(request.url).searchParams, node.nodeId);
  } catch (error) {
    if (!(error instanceof TraceQueryError)) throw error;
    logComplete({
      outcome: "error",
      status: 400,
      errorCode: error.code,
      nodeId: node.nodeId,
    });
    return NextResponse.json({ error: error.code }, { status: 400 });
  }
  const env = query.environment;
  if (!consumeTraceReadBudget(node.nodeId)) {
    logComplete({
      outcome: "error",
      status: 429,
      errorCode: "observability_rate_limited",
      nodeId: node.nodeId,
      env,
    });
    return NextResponse.json(
      { error: "observability_rate_limited" },
      { status: 429, headers: { "Retry-After": "6" } }
    );
  }

  // The operator holds the Langfuse key; a dev never does. 503 until it is ESO-wired.
  const reader = createLangfuseReader();
  if (!reader) {
    logComplete({
      outcome: "error",
      status: 503,
      errorCode: "observability_unwired",
      nodeId: node.nodeId,
    });
    return NextResponse.json(
      { error: "observability_unwired" },
      { status: 503 }
    );
  }

  try {
    const page = LangfuseObservationPageSchema.parse(
      await reader.listObservations(query)
    );
    logComplete({
      outcome: "success",
      status: 200,
      nodeId: node.nodeId,
      ...(env ? { env } : {}),
      count: page.data.length,
    });
    return NextResponse.json(page, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    // Do not log upstream errors, query text or trace content. Public code/status only.
    const code =
      err instanceof Error && "code" in err && typeof err.code === "string"
        ? err.code
        : "observability_upstream_error";
    const failureStatus =
      err instanceof Error && "status" in err && typeof err.status === "number"
        ? err.status
        : 502;
    const status = [400, 429, 502, 503, 504].includes(failureStatus)
      ? failureStatus
      : 502;
    const retryAfter =
      err instanceof Error &&
      "retryAfter" in err &&
      typeof err.retryAfter === "string"
        ? err.retryAfter
        : undefined;
    logComplete({
      outcome: "error",
      status,
      errorCode: code,
      nodeId: node.nodeId,
      env,
    });
    return NextResponse.json(
      { error: code },
      { status, headers: retryAfter ? { "Retry-After": retryAfter } : {} }
    );
  }
}
