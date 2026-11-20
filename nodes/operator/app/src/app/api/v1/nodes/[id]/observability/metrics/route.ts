// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/observability/metrics`
 * Purpose: The node-scoped Mimir read PROXY for developers (sibling of `observability/logs` and `observability/traces`).
 *   A developer of a node reads that node's Prometheus series (request counts per route and status, latency, AI
 *   histograms) with their normal Cogni credential. The operator queries Mimir with its own read path; the developer
 *   never holds a Grafana or Mimir key.
 * Scope: Thin shell — session auth, developer-RBAC gate (same `node.flight` tuple as logs and traces), resolve
 *   {slug|node_id}, confine the PromQL to the node and env (`scopePromQuery`), forward (`forwardNodeMetricsRead`).
 * Invariants:
 *   - DEVELOPER_GATED (`node.flight`); fail-closed without a store.
 *   - NEVER_ISSUES_A_KEY: returns the Prometheus API JSON, never a credential.
 *   - NODE_PIN_IS_FORCED: every vector selector gets `node="<resolved nodeId>",env="<env>"`; the caller cannot widen it.
 *     Lane series carry those labels from the operator's scrape (bug.5641), never from the tenant.
 *   - PRESETS_NEED_NO_PROMQL: `preset=route_status|route_latency_p95&window=1h|24h|7d` builds the query.
 *   - TERMINAL_EVENT: exactly one `feature.node_observability_metrics.complete` per request. Never query text or data.
 * Side-effects: IO (registry read, authz check, Mimir query through the Grafana datasource proxy)
 * Links: features/node-deploy/lease-metrics-read.ts, bootstrap/capabilities/node-metrics-read.ts, traces/route.ts,
 *   https://cognidao.org/knowledge/lease-metrics-forwarding-design
 * @public
 */

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { NextResponse } from "next/server";
import { resolveRouteIdentity } from "@/app/_lib/auth/route-identity";
import { getSessionUser } from "@/app/_lib/auth/session";
import { forwardNodeMetricsRead } from "@/bootstrap/capabilities/node-metrics-read";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { getCurrentTraceId } from "@/bootstrap/otel";
import {
  pickReadParams,
  presetQuery,
  scopePromQuery,
} from "@/features/node-deploy/lease-metrics-read";
import { resolveNodeRef } from "@/features/nodes/node-lookup";
import { FLIGHT_ENVS } from "@/shared/node-registry/deploy-hosts";
import {
  createRequestContext,
  EVENT_NAMES,
  makeLogger,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

interface RouteParams {
  params: Promise<{ id: string }>;
}

const err = (status: number, error: string, message?: string) =>
  NextResponse.json(
    { error, ...(message ? { message } : {}) },
    { status, headers: { "Cache-Control": "no-store" } }
  );

export async function GET(
  request: Request,
  ctx: RouteParams
): Promise<NextResponse> {
  const startedAt = performance.now();
  const reqCtx = createRequestContext({ baseLog, clock }, request, {
    routeId: "nodes.observability-metrics",
    traceId: getCurrentTraceId(),
    session: undefined,
  });
  const logComplete = (fields: {
    outcome: "success" | "error";
    status: number;
    errorCode?: string;
    nodeRef?: string;
    nodeId?: string;
    env?: string;
    kind?: string;
    preset?: string;
    queryChars?: number;
  }): void => {
    const payload = {
      reqId: reqCtx.reqId,
      routeId: reqCtx.routeId,
      durationMs: Math.round(performance.now() - startedAt),
      ...fields,
    };
    const event = EVENT_NAMES.NODE_OBSERVABILITY_METRICS_COMPLETE;
    const level =
      fields.outcome === "success"
        ? "info"
        : fields.status >= 500
          ? "error"
          : "warn";
    reqCtx.log[level]({ event, ...payload }, event);
  };

  const auth = await resolveRouteIdentity(getSessionUser);
  if (!auth.ok) {
    logComplete({
      outcome: "error",
      status: auth.status,
      errorCode: auth.errorCode,
    });
    return auth.response;
  }
  const sessionUser = auth.user;
  if (!sessionUser) {
    logComplete({ outcome: "error", status: 401, errorCode: "unauthorized" });
    return err(401, "unauthorized");
  }

  const { id } = await ctx.params;
  const node = await resolveNodeRef(resolveServiceDb(), id);
  if (!node) {
    logComplete({
      outcome: "error",
      status: 404,
      errorCode: "node_not_found",
      nodeRef: id,
    });
    return err(404, "node_not_found");
  }

  const authorization = getContainer().authorization;
  if (!authorization) {
    logComplete({
      outcome: "error",
      status: 503,
      errorCode: "authz_unavailable",
      nodeId: node.nodeId,
    });
    return err(503, "authz_unavailable");
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
    return err(status, code);
  }

  const source = new URL(request.url).searchParams;
  const env = source.get("env") ?? "production";
  if (!(FLIGHT_ENVS as readonly string[]).includes(env)) {
    logComplete({
      outcome: "error",
      status: 400,
      errorCode: "invalid_env",
      nodeId: node.nodeId,
    });
    return err(
      400,
      "invalid_env",
      `env must be one of ${FLIGHT_ENVS.join(", ")}`
    );
  }
  const preset = source.get("preset");
  if (preset) {
    const query = presetQuery(preset, source.get("window") ?? "24h");
    if (!query) {
      logComplete({
        outcome: "error",
        status: 400,
        errorCode: "invalid_preset",
        nodeId: node.nodeId,
        env,
      });
      return err(
        400,
        "invalid_preset",
        "preset: route_status | route_latency_p95; window: 1h | 24h | 7d"
      );
    }
    source.set("query", query);
    for (const k of ["start", "end", "step"]) source.delete(k);
  }
  const kind = source.has("start") ? "query_range" : "query";
  const base = {
    nodeId: node.nodeId,
    env,
    kind,
    ...(preset ? { preset } : {}),
  };

  const picked = pickReadParams(kind, source);
  if (!picked.ok) {
    logComplete({
      outcome: "error",
      status: 400,
      errorCode: "bad_params",
      ...base,
    });
    return err(400, "bad_params", picked.reason);
  }
  const rawQuery = picked.params.get("query") ?? "";
  const scoped = scopePromQuery(rawQuery, { nodeId: node.nodeId, env });
  if (!scoped.ok) {
    const status = scoped.reason === "scope_unverified" ? 500 : 400;
    logComplete({
      outcome: "error",
      status,
      errorCode: scoped.reason,
      queryChars: rawQuery.length,
      ...base,
    });
    return err(status, "query_refused", scoped.reason);
  }
  picked.params.set("query", scoped.query);

  const forwarded = await forwardNodeMetricsRead(kind, picked.params);
  if (!forwarded.ok) {
    const status =
      forwarded.reason === "timeout"
        ? 504
        : forwarded.reason === "not_configured"
          ? 503
          : 502;
    logComplete({
      outcome: "error",
      status,
      errorCode: forwarded.reason,
      queryChars: rawQuery.length,
      ...base,
    });
    return err(
      status,
      forwarded.reason === "not_configured"
        ? "observability_unwired"
        : forwarded.reason
    );
  }
  logComplete({
    outcome: forwarded.status < 400 ? "success" : "error",
    status: forwarded.status,
    queryChars: rawQuery.length,
    ...base,
  });
  return new NextResponse(forwarded.body, {
    status: forwarded.status,
    headers: {
      "Content-Type": forwarded.contentType,
      "Cache-Control": "no-store",
    },
  });
}
