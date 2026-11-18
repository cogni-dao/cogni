// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/metrics/read/_handle`
 * Purpose: The one handler behind `GET|POST /api/metrics/read/api/v1/{query,query_range}` (story.5169): authenticate a
 *   node lane, confine its PromQL to that lane's series, forward to Mimir, relay the answer.
 * Scope: Request parsing, auth, the refusal responses and one log event per refusal or failure. Credential,
 *   parameter and PromQL rules live in `@features/node-deploy/lease-metrics-read`; the upstream call in
 *   `@bootstrap/capabilities/node-metrics-read`.
 * Invariants:
 *   - CALLER_IS_THE_TOKEN: the caller's node and env come only from the Basic credential; no request parameter, header
 *     or query text names a scope.
 *   - PROMETHEUS_ERROR_SHAPE: every refusal is `{status:"error",errorType,error}`, so a Prometheus client reads it.
 *   - BOUNDED_LOG: one warn per refusal or failure with nodeId (only after a credential parsed), env, kind, reason,
 *     upstream status and query length. Never a token and never query text.
 * Side-effects: IO (outbound HTTPS through the capability)
 * Links: https://prometheus.io/docs/prometheus/latest/querying/api/, story.5169
 * @internal
 */

import { NextResponse } from "next/server";

import { forwardNodeMetricsRead } from "@/bootstrap/capabilities/node-metrics-read";
import {
  authenticateNodeMetricsRead,
  type NodeMetricsReadKind,
  parseNodeBasicAuth,
  pickReadParams,
  scopePromQuery,
} from "@/features/node-deploy/lease-metrics-read";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, type RequestContext } from "@/shared/observability";

/** Largest form body a POST may carry: one query plus a few short parameters. */
const MAX_FORM_BYTES = 16_384;

const refuse = (
  status: number,
  errorType: string,
  error: string,
  headers?: Record<string, string>
) =>
  NextResponse.json(
    { status: "error", errorType, error },
    { status, headers: { "Cache-Control": "no-store", ...headers } }
  );

export async function handleNodeMetricsRead(
  kind: NodeMetricsReadKind,
  ctx: Pick<RequestContext, "log">,
  request: Request
): Promise<NextResponse> {
  const root = serverEnv().METRICS_TOKEN;
  if (!root) return refuse(500, "internal", "METRICS_TOKEN not configured");

  const authorization = request.headers.get("authorization");
  const caller = authenticateNodeMetricsRead(authorization, root);
  if (!caller) {
    // The username is logged only when it parsed as a UUID; the password never is.
    ctx.log.warn(
      {
        kind,
        reason: "unauthorized",
        nodeId: parseNodeBasicAuth(authorization)?.nodeId,
      },
      EVENT_NAMES.NODE_METRICS_READ
    );
    return refuse(401, "unauthorized", "Unauthorized", {
      "WWW-Authenticate": 'Basic realm="node-metrics", charset="UTF-8"',
    });
  }
  const logged = { nodeId: caller.nodeId, env: caller.env, kind };
  const bad = (reason: string, error: string, extra?: object) => {
    ctx.log.warn(
      { ...logged, reason, ...extra },
      EVENT_NAMES.NODE_METRICS_READ
    );
    return refuse(400, "bad_data", error);
  };

  const source = new URL(request.url).searchParams;
  if (request.method === "POST") {
    const type = request.headers.get("content-type") ?? "";
    if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded"))
      return bad("unsupported_content_type", "form-encoded body required");
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_FORM_BYTES) return bad("body_too_large", "body too large");
    const text = await request.text();
    if (text.length > MAX_FORM_BYTES)
      return bad("body_too_large", "body too large");
    // As Prometheus does, a form value wins over the same key in the URL.
    for (const [name, value] of new URLSearchParams(text))
      source.set(name, value);
  }

  const picked = pickReadParams(kind, source);
  if (!picked.ok) return bad("bad_params", picked.reason);
  const rawQuery = picked.params.get("query") ?? "";
  const scoped = scopePromQuery(rawQuery, caller);
  if (!scoped.ok) {
    if (scoped.reason === "scope_unverified") {
      // The splice could not be proven: the operator's gap, not the caller's data. Nothing is forwarded.
      ctx.log.error(
        { ...logged, reason: scoped.reason, queryChars: rawQuery.length },
        EVENT_NAMES.NODE_METRICS_READ
      );
      return refuse(500, "internal", "query could not be scoped");
    }
    return bad(scoped.reason, `query refused: ${scoped.reason}`, {
      queryChars: rawQuery.length,
    });
  }
  picked.params.set("query", scoped.query);

  const forwarded = await forwardNodeMetricsRead(kind, picked.params);
  if (!forwarded.ok) {
    ctx.log.warn(
      { ...logged, reason: forwarded.reason, queryChars: rawQuery.length },
      EVENT_NAMES.NODE_METRICS_READ
    );
    return forwarded.reason === "timeout"
      ? refuse(504, "timeout", "upstream timeout")
      : refuse(502, "unavailable", forwarded.reason);
  }
  if (forwarded.status >= 500)
    ctx.log.warn(
      {
        ...logged,
        reason: "upstream_error",
        upstreamStatus: forwarded.status,
        queryChars: rawQuery.length,
      },
      EVENT_NAMES.NODE_METRICS_READ
    );
  return new NextResponse(forwarded.body, {
    status: forwarded.status,
    headers: {
      "Content-Type": forwarded.contentType,
      "Cache-Control": "no-store",
    },
  });
}
