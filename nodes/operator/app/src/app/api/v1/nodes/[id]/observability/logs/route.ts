// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/observability/logs`
 * Purpose: north-star ② (task.5025) — the node-scoped Loki log-read PROXY. A developer-RBAC'd dev
 *   sends the SAME full LogQL they'd write for loki-query.sh / the Grafana MCP (`?query=`); the
 *   operator authorizes its reach (forcing `{env,service="app",node="<id>"}`), runs it server-side
 *   with its OWN read token, and returns only that node's lines. The dev **never holds a Grafana
 *   token** → node-scoped by construction (the per-node OpenFGA check gates WHO; the rebuilt selector
 *   gates REACH).
 * Scope: Thin shell — Cogni-token auth, developer-RBAC gate (same `node.flight` tuple as flight),
 *   resolve {slug|node_id} against the FULL nodes registry (any status — authz gates, not status),
 *   scope-validate the caller's LogQL, delegate to Loki.
 * Invariants:
 *   - COGNI_TOKEN_ONLY (Bearer-first); DEVELOPER_GATED (`node.flight`); fail-closed without a store.
 *   - NEVER_ISSUES_A_TOKEN: returns log lines, never a Grafana credential.
 *   - NODE_PIN_IS_FORCED: env/service/node are re-emitted server-side; a caller matcher may only narrow
 *     (see scopeNodeLogQL). Out-of-scope selectors → 400, never a widened query.
 *   - GRACEFUL_UNWIRED: 503 `observability_unwired` until the operator's read token is ESO-wired.
 *   - TERMINAL_EVENT: exactly one `feature.node_observability_logs.complete` per request — outcome +
 *     errorCode + target nodeId/env + counts only. Never the raw query, never log lines (privacy).
 * Side-effects: IO (registry read, authz check, Loki query)
 * Links: src/features/nodes/observability-logs.ts, src/bootstrap/observability.factory.ts,
 *   docs/spec/grafana-observability-access.md, flight-status/route.ts (same tuple), task.5025
 * @public
 */

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { createLokiReader } from "@/bootstrap/observability.factory";
import { getCurrentTraceId } from "@/bootstrap/otel";
import { resolveNodeRef } from "@/features/nodes/node-lookup";
import {
  FLIGHT_ENVS,
  isFlightEnv,
  ObservabilityQueryError,
  scopeNodeLogQL,
} from "@/features/nodes/observability-logs";
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

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;
const MAX_MINUTES = 24 * 60;
const DEFAULT_MINUTES = 60;

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
    routeId: "nodes.observability-logs",
    traceId: getCurrentTraceId(),
    session: undefined,
  });

  // Single deterministic terminal event. Privacy: enums/ids/counts only — never the raw LogQL
  // query (caller content) and never the returned log lines.
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
        EVENT_NAMES.NODE_OBSERVABILITY_LOGS_COMPLETE,
        payload,
        EVENT_NAMES.NODE_OBSERVABILITY_LOGS_COMPLETE
      );
      return;
    }
    const level = fields.status >= 500 ? "error" : "warn";
    reqCtx.log[level](
      { event: EVENT_NAMES.NODE_OBSERVABILITY_LOGS_COMPLETE, ...payload },
      EVENT_NAMES.NODE_OBSERVABILITY_LOGS_COMPLETE
    );
  };

  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    logComplete({ outcome: "error", status: 401, errorCode: "unauthorized" });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  // Resolve {id} (repo-spec node_id OR slug) against the FULL registry, any status — a node dev's
  // node is `published` long before it is `active`, so authorization gates access, not the active-only
  // public showcase (`listPublic()` would 404 every real deployed node). Service-role read (no RLS).
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

  // Developer-gated: the SAME `node.flight` tuple as flight. Fail-closed (deny) without a store.
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
  const env = params.get("env");
  if (!isFlightEnv(env)) {
    logComplete({
      outcome: "error",
      status: 400,
      errorCode: "invalid_env",
      nodeId: node.nodeId,
    });
    return NextResponse.json(
      {
        error: "invalid_env",
        message: `env must be one of ${FLIGHT_ENVS.join(", ")}`,
      },
      { status: 400 }
    );
  }

  // Authorize the caller's full LogQL query against this node. `?query=` takes the SAME LogQL a dev
  // writes for loki-query.sh / the MCP; the operator forces env/service/node and lets other labels
  // only narrow. Empty query → just this node's app stream.
  let query: string;
  try {
    query = scopeNodeLogQL({
      env,
      nodeId: node.nodeId,
      query: params.get("query") ?? undefined,
    });
  } catch (err) {
    if (err instanceof ObservabilityQueryError) {
      logComplete({
        outcome: "error",
        status: 400,
        errorCode: err.code,
        nodeId: node.nodeId,
        env,
      });
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: 400 }
      );
    }
    throw err;
  }

  // The operator holds the read token; a dev never does. 503 until it is ESO-wired.
  const reader = createLokiReader();
  if (!reader) {
    logComplete({
      outcome: "error",
      status: 503,
      errorCode: "observability_unwired",
      nodeId: node.nodeId,
      env,
    });
    return NextResponse.json(
      {
        error: "observability_unwired",
        message:
          "operator holds no Grafana read token in this env — set " +
          "cogni/<env>/operator/{GRAFANA_URL,GRAFANA_SERVICE_ACCOUNT_TOKEN} in OpenBao (the operator " +
          "ExternalSecret already delivers the operator path) and force-sync operator-env-secrets",
      },
      { status: 503 }
    );
  }

  const limit = clampInt(params.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  const minutes = clampInt(params.get("minutes"), DEFAULT_MINUTES, MAX_MINUTES);
  const endNs = `${Date.now()}000000`;
  const startNs = `${Date.now() - minutes * 60_000}000000`;

  try {
    const lines = await reader.queryRange({ query, startNs, endNs, limit });
    logComplete({
      outcome: "success",
      status: 200,
      nodeId: node.nodeId,
      env,
      count: lines.length,
    });
    return NextResponse.json({
      nodeId: node.nodeId,
      slug: node.slug,
      env,
      query,
      count: lines.length,
      lines,
    });
  } catch (err) {
    logComplete({
      outcome: "error",
      status: 502,
      errorCode: "loki_query_failed",
      nodeId: node.nodeId,
      env,
    });
    return NextResponse.json(
      {
        error: "loki_query_failed",
        message: err instanceof Error ? err.message : "unknown error",
      },
      { status: 502 }
    );
  }
}
