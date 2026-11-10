// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/substrate-health/substrate-kpis`
 * Purpose: The operator's node-local goal-metric calculator for shared-substrate host pressure (bug.5613):
 *   `substrate.host-pressure@1` reads the per-host node_exporter and k3s-kine series every substrate VM pushes to
 *   Grafana Cloud Mimir, and reports the worst host of one env. It makes VM starvation (IO wait, swap-in, low
 *   memory, an unbounded k3s state.db) a goal reading, so it can no longer hide behind green delivery and
 *   uptime KPIs (2026-11-09/10 candidate-a: kine state.db 6.57 GB, IO wait 55-65%, Temporal and AI chat down).
 *   Registered through `@cogni-dao/metrics` `createGoalMetrics({ nodeCalculators })`.
 * Scope: Pure query building, aggregation and the calculator object. The only IO is the injected
 *   `queryInstant` of `MetricsQueryPort` (the existing Mimir adapter), called through `ctx.read`.
 * Invariants:
 *   - ENV_AND_OUTPUT_FROM_ENUM: the PromQL `env` label comes only from a strict `^[a-z0-9-]{1,40}$` param and the
 *     metric name only from the output enum. No free text reaches a query.
 *   - WORST_HOST_WINS: a reading is the worst host of the env (max IO wait, max swap-in, min memory available, max
 *     kine bytes), never a mean that hides one starved VM. Per-host values go to the evidence refs.
 *   - ABSENCE_IS_FAILING: no series for the env (a dead exporter, an uninstalled compaction timer, a stopped
 *     scrape) is an incomplete sample, which the package assesses as failing. It is never 0 and never a pass.
 *     Missing kine carries `substrate:kine_exporter_absent`; the package reason enum has no distinct code.
 *   - SOURCE_ERROR_IS_UNAVAILABLE: a Mimir failure or a missing reader is an incomplete sample
 *     (`source_failed`, or `calculator_unavailable` plus `substrate:source_unconfigured`), never a fake 0.
 *   - ROUND_TOWARD_BREACH: "lower is better" values round up and "higher is better" values round down at three
 *     decimals, so rounding never turns a breach into a pass at a target such as 10.
 *   - IDS_USE_DASHES: the calculator id matches `MetricSpecSchema.calculatorId` (no underscores).
 * Side-effects: none (the calculator calls the injected reader)
 * Links: ports/metrics-query.port.ts, adapters/server/metrics/grafana-mimir.adapter.ts,
 *   bootstrap/capabilities/goal-metrics.ts, features/node-deploy/fleet-kpis.ts, bug.5613
 * @public
 */

import type {
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { z } from "zod";
import type { MetricsQueryPort, PrometheusInstantResult } from "@/ports";

export const HOST_PRESSURE_ID = "substrate.host-pressure@1";

/** The one Mimir operation the calculator needs. `MetricsQueryPort` satisfies it. */
export type SubstratePrometheusReader = Pick<MetricsQueryPort, "queryInstant">;

/** Evidence lists at most this many hosts. */
const MAX_EVIDENCE = 20;
/** Most series one query may return before the read counts as truncated. */
const MAX_SERIES = 200;
/** The rate window of the IO-wait and swap-in queries. */
const RATE_WINDOW = "5m";

export const SUBSTRATE_OUTPUTS = [
  "io_pressure",
  "swap_in",
  "memory_available",
  "kine_bytes",
] as const;
export type SubstrateOutput = (typeof SUBSTRATE_OUTPUTS)[number];

const paramsSchema = z.strictObject({
  env: z.string().regex(/^[a-z0-9-]{1,40}$/),
  output: z.enum(SUBSTRATE_OUTPUTS),
});

interface OutputSpec {
  readonly unit: string;
  /** The worst host: `high` means the largest value is worst, `low` means the smallest is. */
  readonly worst: "high" | "low";
  /** Prometheus series the query reads, named in the missing-series evidence. */
  readonly series: string;
  readonly query: (env: string) => string;
  /** Scale a raw host value into the reading unit, rounding toward breach. */
  readonly finish: (raw: number) => number;
}

// Round away float noise at 1e-6 first, so 10 * 1.0000000000000002 does not become 10.001.
const ceil3 = (x: number) => Math.ceil(Math.round(x * 1e6) / 1e3) / 1e3;
const floor3 = (x: number) => Math.floor(Math.round(x * 1e6) / 1e3) / 1e3;

/** Per-output query and arithmetic. Inputs are the validated env and the output enum only. */
export const OUTPUTS: Readonly<Record<SubstrateOutput, OutputSpec>> = {
  // PSI IO stall as a 0..1 fraction of wall time; the reading is a percent.
  io_pressure: {
    unit: "%",
    worst: "high",
    series: "node_pressure_io_waiting_seconds_total",
    query: (env) =>
      `max by (instance) (rate(node_pressure_io_waiting_seconds_total{env="${env}"}[${RATE_WINDOW}]))`,
    finish: (raw) => ceil3(100 * raw),
  },
  swap_in: {
    unit: "pages/s",
    worst: "high",
    series: "node_vmstat_pswpin",
    query: (env) =>
      `max by (instance) (rate(node_vmstat_pswpin{env="${env}"}[${RATE_WINDOW}]))`,
    finish: ceil3,
  },
  memory_available: {
    unit: "%",
    worst: "low",
    series: "node_memory_MemAvailable_bytes",
    query: (env) =>
      `100 * sum by (instance) (node_memory_MemAvailable_bytes{env="${env}"}) / sum by (instance) (node_memory_MemTotal_bytes{env="${env}"})`,
    finish: floor3,
  },
  // Textfile exporter from infra/provision/cherry/base/bootstrap.yaml; its absence means it is not installed.
  kine_bytes: {
    unit: "bytes",
    worst: "high",
    series: "node_k3s_kine_state_db_bytes",
    query: (env) =>
      `max by (instance) (node_k3s_kine_state_db_bytes{env="${env}"})`,
    finish: Math.ceil,
  },
};

const unknownSample = (
  unit: string,
  reason: NonNullable<MetricSample["reason"]>,
  asOf: string,
  evidenceRefs: string[]
): MetricSample => ({
  value: 0,
  unit,
  complete: false,
  reason,
  sourceWatermarks: [{ source: "prometheus", asOf }],
  evidenceRefs,
});

export interface SubstrateCalculatorOptions {
  /** The Mimir reader; absent when the operator has no Grafana read credential. */
  readonly prometheus: SubstratePrometheusReader | undefined | null;
}

export function createSubstrateCalculators({
  prometheus,
}: SubstrateCalculatorOptions): MetricCalculator[] {
  const hostPressure: MetricCalculator = {
    id: HOST_PRESSURE_ID,
    unit: "%",
    unitFor: (params) => OUTPUTS[paramsSchema.parse(params).output].unit,
    display: "progress",
    paramsSchema,
    budget: {
      timeoutMs: 15_000,
      maxSourceCalls: 1,
      maxRows: MAX_SERIES,
      maxResponseBytes: 1_048_576,
    },
    async compute(params, ctx) {
      const p = paramsSchema.parse(params);
      const spec = OUTPUTS[p.output];
      const head = `substrate:env=${p.env},output=${p.output}`;
      const endMs = new Date(ctx.window.end).getTime();
      const asOf = new Date(endMs).toISOString();
      if (!prometheus)
        return unknownSample(spec.unit, "calculator_unavailable", asOf, [
          head,
          "substrate:source_unconfigured",
        ]);

      let result: PrometheusInstantResult;
      try {
        result = await ctx.read((signal) => {
          signal.throwIfAborted();
          return prometheus.queryInstant({
            query: spec.query(p.env),
            time: new Date(endMs),
            signal,
          });
        });
      } catch {
        return unknownSample(spec.unit, "source_failed", asOf, [head]);
      }

      if (result.result.length > MAX_SERIES)
        return unknownSample(spec.unit, "incomplete_or_invalid_source", asOf, [
          head,
          `substrate:series>${MAX_SERIES}`,
        ]);
      // ABSENCE_IS_FAILING: nothing reported for this env means the fleet is blind here, not healthy.
      if (result.result.length === 0)
        return unknownSample(spec.unit, "incomplete_or_invalid_source", asOf, [
          head,
          p.output === "kine_bytes"
            ? "substrate:kine_exporter_absent"
            : "substrate:series_missing",
          `substrate:series=${spec.series}`,
        ]);

      const hosts = result.result.map((s) => ({
        host: s.metric.instance || "unknown",
        value: Number(s.value[1]),
      }));
      if (hosts.some((h) => !Number.isFinite(h.value)))
        return unknownSample(spec.unit, "incomplete_or_invalid_source", asOf, [
          head,
          "substrate:non_finite_value",
        ]);

      // WORST_HOST_WINS: sort worst first; ties break on host name for stable evidence.
      const sign = spec.worst === "high" ? -1 : 1;
      hosts.sort(
        (a, b) => sign * (a.value - b.value) || (a.host < b.host ? -1 : 1)
      );
      const worst = hosts[0] as { host: string; value: number };
      return {
        value: spec.finish(worst.value),
        unit: spec.unit,
        complete: true,
        sourceWatermarks: [{ source: "prometheus", asOf }],
        evidenceRefs: [
          `${head},hosts=${hosts.length},worst=${worst.host}`,
          ...hosts
            .slice(0, MAX_EVIDENCE)
            .map((h) => `host:${h.host}=${spec.finish(h.value)}${spec.unit}`),
        ],
      };
    },
  };
  return [hostPressure];
}
