// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/finance/grafana-overage.reader`
 * Purpose: Grafana Cloud · overage this month — USD month-to-date overage from the usage datasource, averaged over the UTC days elapsed.
 * Scope: Two Prometheus instant queries through the stack's datasource proxy with the service-account token (GRAFANA_URL +
 *   GRAFANA_SERVICE_ACCOUNT_TOKEN). The per-product breakdown is Source-dialog evidence only.
 * Invariants: READERS_NEVER_THROW. Missing credential ⇒ UNKNOWN "no Grafana credential". A usage line has no balance and no runway.
 *   Metrics are an estimate: the Source line says "verify against invoice".
 * Side-effects: IO (HTTPS GET via injected fetch)
 * Links: https://cognidao.org/knowledge/money-plane-registry, https://cognidao.org/work/items/task.5347
 * @public
 */
import {
  type FetchLike,
  type PlaneReader,
  unknownRow,
} from "@cogni/money-plane";

import type { FinanceRow, FinanceRowPart } from "@/ports/finance-report.port";

export const GRAFANA_OVERAGE_PLANE = "grafana:overage";
export const GRAFANA_USAGE_DATASOURCE_UID = "grafanacloud-usage";
export const GRAFANA_TOTAL_OVERAGE_METRIC = "grafanacloud_org_total_overage";
export const GRAFANA_OVERAGE_BREAKDOWN_QUERY =
  '{__name__=~"grafanacloud_org_.*_overage"}';

/** Month-to-date USD ÷ UTC days elapsed this month (day 26 ⇒ ÷ 26). */
export function overagePerDay(totalUsd: number, at: Date): number {
  return totalUsd / at.getUTCDate();
}

interface PromResult {
  metric?: Record<string, unknown>;
  value?: [unknown, unknown];
}
function results(body: unknown): PromResult[] {
  const data = (body as { data?: { result?: unknown } } | null)?.data;
  return Array.isArray(data?.result) ? (data.result as PromResult[]) : [];
}
function sample(result: PromResult | undefined): number | null {
  const value = Number(result?.value?.[1]);
  return Number.isFinite(value) ? value : null;
}

export interface GrafanaOverageReaderOptions {
  url: string | null | undefined;
  token: string | null | undefined;
  fetch: FetchLike;
  now?: () => Date;
}

export function grafanaOverageReader(
  options: GrafanaOverageReaderOptions
): PlaneReader {
  const plane = GRAFANA_OVERAGE_PLANE;
  const label = "Grafana overage";
  const now = options.now ?? (() => new Date());
  const unknown = (
    reasonCode: "unconfigured" | "unreadable",
    detail: string
  ): FinanceRow => ({
    ...unknownRow({
      plane,
      label,
      kind: "usage",
      reasonCode,
      observedAt: now().toISOString(),
      detail,
    }),
    payer: "Operator",
  });
  return {
    plane,
    label,
    kind: "usage",
    async read(signal): Promise<FinanceRow> {
      if (!options.url || !options.token)
        return unknown("unconfigured", "no Grafana credential");
      const base = `${options.url.replace(/\/+$/, "")}/api/datasources/proxy/uid/${GRAFANA_USAGE_DATASOURCE_UID}/api/v1/query?query=`;
      const query = async (promql: string): Promise<unknown> => {
        const res = await options.fetch(
          `${base}${encodeURIComponent(promql)}`,
          { headers: { Authorization: `Bearer ${options.token}` }, signal }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      };
      try {
        const total = sample(
          results(await query(GRAFANA_TOTAL_OVERAGE_METRIC))[0]
        );
        if (total === null) return unknown("unreadable", "no overage sample");
        let parts: FinanceRowPart[] = [];
        try {
          parts = results(await query(GRAFANA_OVERAGE_BREAKDOWN_QUERY)).flatMap(
            (r) => {
              const name = String(r.metric?.__name__ ?? "");
              const value = sample(r);
              return name === GRAFANA_TOTAL_OVERAGE_METRIC || value === null
                ? []
                : [
                    {
                      label: name
                        .replace(/^grafanacloud_org_/, "")
                        .replace(/_overage$/, "")
                        .replace(/_/g, " "),
                      amount: String(value),
                      currency: "USD",
                    },
                  ];
            }
          );
        } catch {
          /* The breakdown is evidence only; the total still stands. */
        }
        const at = now();
        const observedAt = at.toISOString();
        return {
          plane,
          label,
          kind: "usage",
          balance: null,
          currency: "USD",
          burnPerDay: overagePerDay(total, at),
          runwayDays: null,
          grade: "INFO",
          observedAt,
          source: "Grafana Cloud usage metrics · verify against invoice",
          sourceObservedAt: observedAt,
          freshness: "current",
          payer: "Operator",
          detail: `${total.toFixed(2)} USD month to date · day ${at.getUTCDate()}`,
          parts,
        };
      } catch {
        return unknown("unreadable", "Grafana usage read failed");
      }
    },
  };
}
