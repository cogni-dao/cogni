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
import type { MetricsQueryPort } from "@/ports";
import { MimirMetricsAdapter } from "./mimir.adapter";

interface GrafanaMimirInput {
  grafanaUrl: string;
  bearerToken: string;
  timeoutMs: number;
}

/**
 * Synchronous wiring for request-path containers (bug.5519): datasource
 * discovery runs on first read and is retried after a failed discovery.
 */
export function createLazyGrafanaMimirAdapter(
  input: GrafanaMimirInput
): MetricsQueryPort {
  let adapter: Promise<MimirMetricsAdapter> | null = null;
  const resolve = () => {
    adapter ??= createGrafanaMimirAdapter(input).catch((error: unknown) => {
      adapter = null;
      throw error;
    });
    return adapter;
  };
  return {
    queryRange: async (params) => (await resolve()).queryRange(params),
    queryInstant: async (params) => (await resolve()).queryInstant(params),
    queryTemplate: async (params) => (await resolve()).queryTemplate(params),
    queryReliabilitySnapshot: async (params) =>
      (await resolve()).queryReliabilitySnapshot(params),
  };
}

export async function createGrafanaMimirAdapter(
  input: GrafanaMimirInput
): Promise<MimirMetricsAdapter> {
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
  return new MimirMetricsAdapter({
    url: proxy.toString(),
    bearerToken: input.bearerToken,
    timeoutMs: input.timeoutMs,
  });
}
