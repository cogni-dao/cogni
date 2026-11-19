// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-metrics-read`
 * Purpose: Forward one already-scoped Prometheus read (`query` or `query_range`) to the governed Mimir datasource
 *   through the Grafana datasource proxy (story.5169). Routes may not import adapters, so the wiring lives here.
 * Scope: Upstream discovery (cached, retried after a failure) and one bounded GET. Authentication and PromQL scoping
 *   happen before this runs, in `@features/node-deploy/lease-metrics-read`.
 * Invariants:
 *   - OPERATOR_READ_PATH: the upstream is the proven one the operator's own goal reader uses (`GRAFANA_URL` +
 *     `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `discoverGrafanaMimirSource`); `PROMETHEUS_READ_*` is never read.
 *   - BOUNDED_RESPONSE: the body is read as a stream and refused past `NODE_METRICS_READ_MAX_BYTES`, so one query cannot
 *     make the operator hold an unbounded body. The deadline covers connect and body.
 *   - UPSTREAM_BODY_UNCHANGED: a complete upstream response is returned with its status and JSON body untouched.
 * Side-effects: IO (outbound HTTPS to the Grafana datasource proxy)
 * Links: features/node-deploy/lease-metrics-read.ts, adapters/server/metrics/grafana-mimir.adapter.ts, story.5169
 * @internal
 */

import {
  discoverGrafanaMimirSource,
  type GrafanaMimirSource,
} from "@/adapters/server";
import { serverEnv } from "@/shared/env";

/** Largest upstream body relayed to a node, in bytes. */
export const NODE_METRICS_READ_MAX_BYTES = 5_000_000;
/** The whole upstream call, connect and body. */
export const NODE_METRICS_READ_TIMEOUT_MS = 15_000;
/** Datasource discovery deadline. */
const DISCOVERY_TIMEOUT_MS = 10_000;

export type NodeMetricsForward =
  | {
      readonly ok: true;
      readonly status: number;
      readonly body: string;
      readonly contentType: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "not_configured"
        | "upstream_unavailable"
        | "timeout"
        | "too_large";
    };

let source: Promise<GrafanaMimirSource> | undefined;

/** Discovery runs on first use and a failure is retried on the next read, so a Grafana outage cannot pin it broken. */
function upstream(
  grafanaUrl: string,
  token: string
): Promise<GrafanaMimirSource> {
  source ??= discoverGrafanaMimirSource({
    grafanaUrl,
    bearerToken: token,
    timeoutMs: DISCOVERY_TIMEOUT_MS,
  }).catch((error: unknown) => {
    source = undefined;
    throw error;
  });
  return source;
}

async function readCapped(
  response: Response,
  maxBytes: number
): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Forward `params` to `<datasource proxy>/api/v1/<kind>`. Never throws; a failure is a bounded reason. */
export async function forwardNodeMetricsRead(
  kind: "query" | "query_range",
  params: ReadonlyMap<string, string>
): Promise<NodeMetricsForward> {
  const { GRAFANA_URL: grafanaUrl, GRAFANA_SERVICE_ACCOUNT_TOKEN: token } =
    serverEnv();
  if (!grafanaUrl || !token) return { ok: false, reason: "not_configured" };
  const signal = AbortSignal.timeout(NODE_METRICS_READ_TIMEOUT_MS);
  try {
    const target = await upstream(grafanaUrl, token);
    const url = new URL(`${target.url}/api/v1/${kind}`);
    for (const [name, value] of params) url.searchParams.set(name, value);
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${target.bearerToken}`,
        accept: "application/json",
      },
      redirect: "error",
      signal,
    });
    const body = await readCapped(response, NODE_METRICS_READ_MAX_BYTES);
    if (body === null) return { ok: false, reason: "too_large" };
    return {
      ok: true,
      status: response.status,
      body,
      contentType: response.headers.get("content-type") ?? "application/json",
    };
  } catch (error) {
    const timedOut =
      signal.aborted ||
      (error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError"));
    return { ok: false, reason: timedOut ? "timeout" : "upstream_unavailable" };
  }
}
