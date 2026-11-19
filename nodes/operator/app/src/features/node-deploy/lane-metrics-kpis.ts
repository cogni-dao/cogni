// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/lane-metrics-kpis`
 * Purpose: The goal-metric calculator that alerts when a node app's metrics stop arriving (bug.5641 R3):
 *   `fleet.lane-metrics@1` counts the serving node-app lanes of one env whose `/api/metrics` did not reach Mimir
 *   over the window. The goal binding (`breach: failing`) is the alert; there is no Grafana rule (CEO, #3190).
 * Scope: Pure classification and the calculator object. IO is the injected release-store lane read and the
 *   injected `queryInstant` of `MetricsQueryPort`, both called through `ctx.read`.
 * Invariants:
 *   - DECLARED_VS_OBSERVED: the denominator is the release store's serving node-app lanes (the same read the HTTP SD
 *     route lists), never the series Mimir happens to hold. A lane with no `up{job="node-lanes"}` series is dark, so a
 *     stopped scraper, a missing Alloy job or a lane that was never discovered reads as dark, not as healthy.
 *   - DARK_IS_ANY_MISS: a lane is dark when its lowest `up` over the window is below 1.
 *   - UNKNOWN_IS_A_RESULT: no Mimir reader, a store or Mimir failure, a truncated read or zero lanes is an incomplete
 *     sample with a reason, never 0 and never a pass.
 *   - ENV_FROM_SCHEMA: the PromQL `env` value comes only from a strict `^[a-z0-9-]{1,40}$` param.
 *   - IDS_USE_DASHES: the calculator id matches `MetricSpecSchema.calculatorId`.
 * Side-effects: none (the calculator calls the injected readers)
 * Links: features/node-deploy/lease-metrics.ts, bootstrap/capabilities/goal-metrics.ts,
 *   https://cognidao.org/knowledge/lease-metrics-forwarding-design, bug.5641
 * @public
 */

import type {
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { z } from "zod";
import type { MetricsQueryPort, PrometheusInstantResult } from "@/ports";
import { MAX_LEASE_LANES } from "./lease-metrics";

export const LANE_METRICS_ID = "fleet.lane-metrics@1";

/** The lowest `up` per lane over this window decides dark. Two scrape intervals of 30 s fit many times over. */
const WINDOW = "10m";
/** Evidence names at most this many dark lanes. */
const MAX_EVIDENCE = 20;

export interface LaneMetricsLane {
  readonly nodeId: string;
  readonly env: string;
  readonly workload: string;
}

/** The serving node-app lanes of one env (`DeliveryKpiSource.servingLanes` with `nodeAppsOnly`). */
export type LaneMetricsLaneReader = (
  env: string,
  signal: AbortSignal
) => Promise<{
  readonly lanes: readonly LaneMetricsLane[];
  readonly truncated: boolean;
}>;

export type LaneMetricsPrometheusReader = Pick<
  MetricsQueryPort,
  "queryInstant"
>;

const paramsSchema = z.strictObject({
  env: z.string().regex(/^[a-z0-9-]{1,40}$/),
});

export const laneUpQuery = (env: string): string =>
  `min by (node, env, workload) (min_over_time(up{job="node-lanes",env="${env}"}[${WINDOW}]))`;

const laneKey = (l: LaneMetricsLane) => `${l.nodeId}/${l.env}/${l.workload}`;

/** Dark lanes: declared lanes whose lowest `up` is below 1 or that have no series at all. */
export function darkLanes(
  lanes: readonly LaneMetricsLane[],
  series: PrometheusInstantResult["result"]
): LaneMetricsLane[] {
  const up = new Map<string, number>();
  for (const s of series) {
    const key = `${s.metric.node}/${s.metric.env}/${s.metric.workload}`;
    up.set(key, Number(s.value[1]));
  }
  return lanes.filter((l) => {
    const v = up.get(laneKey(l));
    return v === undefined || !Number.isFinite(v) || v < 1;
  });
}

const unknown = (
  reason: NonNullable<MetricSample["reason"]>,
  asOf: string,
  evidenceRefs: string[]
): MetricSample => ({
  value: 0,
  unit: "lanes",
  complete: false,
  reason,
  sourceWatermarks: [{ source: "prometheus", asOf }],
  evidenceRefs,
});

export function createLaneMetricsCalculators(deps: {
  readonly lanes: LaneMetricsLaneReader;
  /** The Mimir reader; absent when the operator has no Grafana read credential. */
  readonly prometheus: LaneMetricsPrometheusReader | undefined | null;
}): MetricCalculator[] {
  const laneMetrics: MetricCalculator = {
    id: LANE_METRICS_ID,
    unit: "lanes",
    display: "volume",
    paramsSchema,
    budget: {
      timeoutMs: 15_000,
      maxSourceCalls: 2,
      maxRows: MAX_LEASE_LANES,
      maxResponseBytes: 1_048_576,
    },
    async compute(params, ctx) {
      const p = paramsSchema.parse(params);
      const head = `lanemetrics:env=${p.env}`;
      const endMs = new Date(ctx.window.end).getTime();
      const asOf = new Date(endMs).toISOString();
      if (!deps.prometheus)
        return unknown("calculator_unavailable", asOf, [
          head,
          "lanemetrics:source_unconfigured",
        ]);
      const prometheus = deps.prometheus;

      let declared: Awaited<ReturnType<LaneMetricsLaneReader>>;
      let result: PrometheusInstantResult;
      try {
        declared = await ctx.read((signal) => deps.lanes(p.env, signal));
        result = await ctx.read((signal) => {
          signal.throwIfAborted();
          return prometheus.queryInstant({
            query: laneUpQuery(p.env),
            time: new Date(endMs),
            signal,
          });
        });
      } catch {
        return unknown("source_failed", asOf, [head]);
      }
      if (declared.truncated)
        return unknown("incomplete_or_invalid_source", asOf, [
          head,
          "lanemetrics:lanes_truncated",
        ]);
      if (declared.lanes.length === 0)
        return unknown("incomplete_or_invalid_source", asOf, [
          head,
          "lanemetrics:no_lanes",
        ]);

      const dark = darkLanes(declared.lanes, result.result);
      return {
        value: dark.length,
        unit: "lanes",
        complete: true,
        sourceWatermarks: [{ source: "prometheus", asOf }],
        evidenceRefs: [
          `${head},declared=${declared.lanes.length},dark=${dark.length}`,
          ...dark
            .slice(0, MAX_EVIDENCE)
            .map((l) => `dark:${l.nodeId}/${l.workload}`),
        ],
      };
    },
  };
  return [laneMetrics];
}
