// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/metrics/grafana-mimir`
 * Purpose: Query the configured Prometheus source through its existing Grafana datasource authority.
 * Scope: Read-only discovery and proxy configuration; does not mint tokens or select arbitrary sources.
 * Invariants: GOVERNED_DATASOURCE_UID, SINGLE_DATASOURCE, SAME_ORIGIN, NO_AUTH_FALLBACK.
 *   The governed source must be a Grafana Cloud Mimir at https://prometheus-<id>.grafana.net/api/prom
 *   or its internal NLB form https://prometheus-<id>.internal.grafana.net/api/prom (bug.5514);
 *   the adapter never dials it, only proxies through the Grafana origin.
 * Side-effects: IO
 * Links: infra/secrets-catalog.yaml, adapters/server/metrics/mimir.adapter.ts
 * @internal
 */

import { z } from "zod";
import { MimirMetricsAdapter } from "./mimir.adapter";

export interface GrafanaMimirSource {
  /** The governed datasource proxy base; `<url>/api/v1/query[_range]` is the Prometheus API. */
  readonly url: string;
  readonly bearerToken: string;
}

/**
 * Discover the governed Mimir datasource and return its Grafana proxy URL and the token that reaches it. One
 * authority for the operator's own adapter and for the node-scoped read proxy (story.5169).
 */
export async function discoverGrafanaMimirSource(input: {
  grafanaUrl: string;
  bearerToken: string;
  timeoutMs: number;
}): Promise<GrafanaMimirSource> {
  const grafana = new URL(input.grafanaUrl);
  if (
    grafana.protocol !== "https:" ||
    grafana.username ||
    grafana.password ||
    grafana.search ||
    grafana.hash ||
    !["", "/"].includes(grafana.pathname) ||
    !input.bearerToken
  )
    throw new Error("grafana_metrics_source_configuration_invalid");
  const response = await fetch(new URL("/api/datasources", grafana.origin), {
    headers: { authorization: `Bearer ${input.bearerToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!response.ok)
    throw new Error("grafana_metrics_source_discovery_unavailable");
  const sources = z
    .array(
      z.object({
        uid: z.string(),
        type: z.string(),
        url: z.string(),
      })
    )
    .parse(await response.json());
  const matches = sources.filter(
    (row) => row.uid === "grafanacloud-prom" && row.type === "prometheus"
  );
  if (matches.length !== 1 || !matches[0])
    throw new Error("grafana_metrics_source_missing_or_ambiguous");
  const source = new URL(matches[0].url);
  if (
    source.protocol !== "https:" ||
    source.username ||
    source.password ||
    source.search ||
    source.hash ||
    source.pathname.replace(/\/$/, "") !== "/api/prom" ||
    !/^prometheus-[a-z0-9-]+(\.internal)?\.grafana\.net$/.test(source.hostname)
  )
    throw new Error("grafana_metrics_source_identity_invalid");
  const proxy = new URL(
    `/api/datasources/proxy/uid/${matches[0].uid}`,
    grafana.origin
  );
  if (proxy.origin !== grafana.origin)
    throw new Error("grafana_metrics_proxy_origin_mismatch");
  return { url: proxy.toString(), bearerToken: input.bearerToken };
}

export async function createGrafanaMimirAdapter(input: {
  grafanaUrl: string;
  bearerToken: string;
  timeoutMs: number;
}): Promise<MimirMetricsAdapter> {
  const source = await discoverGrafanaMimirSource(input);
  return new MimirMetricsAdapter({
    url: source.url,
    bearerToken: source.bearerToken,
    timeoutMs: input.timeoutMs,
  });
}
