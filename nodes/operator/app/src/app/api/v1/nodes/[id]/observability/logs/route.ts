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
 *   resolve {slug|node_id} via dev1's registry, scope-validate the caller's LogQL, delegate to Loki.
 * Invariants:
 *   - COGNI_TOKEN_ONLY (Bearer-first); DEVELOPER_GATED (`node.flight`); fail-closed without a store.
 *   - NEVER_ISSUES_A_TOKEN: returns log lines, never a Grafana credential.
 *   - NODE_PIN_IS_FORCED: env/service/node are re-emitted server-side; a caller matcher may only narrow
 *     (see scopeNodeLogQL). Out-of-scope selectors → 400, never a widened query.
 *   - GRACEFUL_UNWIRED: 503 `observability_unwired` until the operator's read token is ESO-wired.
 * Side-effects: IO (registry read, authz check, Loki query)
 * Links: src/features/nodes/observability-logs.ts, src/bootstrap/observability.factory.ts,
 *   docs/spec/grafana-observability-access.md, flight-status/route.ts (same tuple), task.5025
 * @public
 */

import type { AuthzDecisionCode } from "@cogni/authorization-core";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer, resolveNodeRegistry } from "@/bootstrap/container";
import { createLokiReader } from "@/bootstrap/observability.factory";
import {
  FLIGHT_ENVS,
  isFlightEnv,
  ObservabilityQueryError,
  scopeNodeLogQL,
} from "@/features/nodes/observability-logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  // Consume dev1's registry: match {id} as either the repo-spec nodeId (UUID) or the slug.
  const summaries = await resolveNodeRegistry().listPublic();
  const node = summaries.find((n) => n.nodeId === id || n.slug === id);
  if (!node?.nodeId) {
    return NextResponse.json({ error: "node_not_found" }, { status: 404 });
  }

  // Developer-gated: the SAME `node.flight` tuple as flight. Fail-closed (deny) without a store.
  const authorization = getContainer().authorization;
  if (!authorization) {
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
    return NextResponse.json(
      { error: code },
      { status: code === "authz_unavailable" ? 503 : 403 }
    );
  }

  const params = new URL(request.url).searchParams;
  const env = params.get("env");
  if (!isFlightEnv(env)) {
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
    return NextResponse.json(
      {
        error: "observability_unwired",
        message:
          "operator holds no Grafana read token in this env — ESO wire of " +
          "cogni/<env>/_shared/{GRAFANA_URL,GRAFANA_SERVICE_ACCOUNT_TOKEN} into the operator pod is pending",
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
    return NextResponse.json({
      nodeId: node.nodeId,
      slug: node.slug,
      env,
      query,
      count: lines.length,
      lines,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "loki_query_failed",
        message: err instanceof Error ? err.message : "unknown error",
      },
      { status: 502 }
    );
  }
}
