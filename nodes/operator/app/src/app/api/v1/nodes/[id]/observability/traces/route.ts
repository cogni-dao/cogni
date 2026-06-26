// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/observability/traces`
 * Purpose: The node-scoped Langfuse AI-trace read PROXY (sibling of `observability/logs`). A
 *   developer-RBAC'd dev lists their node's traces; the operator queries Langfuse with its OWN key
 *   (the same key the trace-writing decorator uses), pinned server-side to `tags=<nodeId>`, and
 *   returns only that node's traces. The dev **never holds the Langfuse key** → node-scoped by
 *   construction (the per-node OpenFGA check gates WHO; the forced `nodeId` tag gates REACH). The
 *   key reads the whole shared Langfuse project, so it is never handed over (same reach correction
 *   as the Grafana proxy).
 * Scope: Thin shell — session auth, developer-RBAC gate (same `node.flight` tuple as flight), resolve
 *   {slug|node_id} against the FULL registry (any status), delegate to the Langfuse reader pinned to
 *   the resolved node.
 * Invariants:
 *   - DEVELOPER_GATED (`node.flight`); fail-closed without a store.
 *   - NEVER_ISSUES_A_KEY: returns trace summaries, never the Langfuse credential.
 *   - NODE_PIN_IS_FORCED: the reader is always pinned to the resolved node's `nodeId` tag; the caller
 *     cannot widen it (LANGFUSE_NODE_ATTRIBUTION / LANGFUSE_DEV_READ_IS_PROXIED).
 *   - GRACEFUL_UNWIRED: 503 `observability_unwired` until the operator's Langfuse key is ESO-wired.
 *   - TERMINAL_EVENT: exactly one `feature.node_observability_traces.complete` per request — outcome +
 *     errorCode + target nodeId/env + count only. Never trace content.
 * Side-effects: IO (registry read, authz check, Langfuse query)
 * Links: src/bootstrap/observability.factory.ts, src/ports/langfuse-reader.port.ts,
 *   docs/spec/substrate-access-grant.md, docs/spec/observability.md#langfuse-integration, logs/route.ts
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

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

interface RouteParams {
  params: Promise<{ id: string }>;
}

function clampInt(raw: string | null, def: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

export async function GET(
  request: Request,
  ctx: RouteParams
): Promise<NextResponse> {
  const startedAt = performance.now();
  const reqCtx = createRequestContext({ baseLog, clock }, request, {
    routeId: "nodes.observability-traces",
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

  const params = new URL(request.url).searchParams;
  const env = params.get("env") ?? undefined;
  const limit = clampInt(params.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);

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
    const traces = await reader.listTraces({
      nodeId: node.nodeId,
      limit,
      ...(env ? { environment: env } : {}),
    });
    logComplete({
      outcome: "success",
      status: 200,
      nodeId: node.nodeId,
      ...(env ? { env } : {}),
      count: traces.length,
    });
    return NextResponse.json({ nodeId: node.nodeId, traces });
  } catch (err) {
    reqCtx.log.error(
      { err, nodeId: node.nodeId },
      "langfuse trace read failed"
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
