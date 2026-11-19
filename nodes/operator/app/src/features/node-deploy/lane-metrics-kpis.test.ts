// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/lane-metrics-kpis.test`
 * Purpose: Prove `fleet.lane-metrics@1` (bug.5641 R3) over fake lane and Mimir readers: every declared lane with
 *   `up` 1 reads 0 dark; a lane with `up` 0 or with no series at all is dark (a stopped scraper is never healthy);
 *   series for undeclared lanes are ignored; a missing reader, a failed read, a truncated read or zero lanes is an
 *   incomplete sample and never 0; and the query carries only the validated env.
 * Side-effects: none
 */

import type {
  CalculatorContext,
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { describe, expect, it } from "vitest";
import type { InstantQueryParams, PrometheusInstantResult } from "@/ports";
import {
  createLaneMetricsCalculators,
  LANE_METRICS_ID,
  type LaneMetricsLane,
  type LaneMetricsLaneReader,
  type LaneMetricsPrometheusReader,
  laneUpQuery,
} from "./lane-metrics-kpis";

const NOW = Date.parse("2026-11-19T01:00:00.000Z");
const A = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const B = "4b06359a-a859-4399-888e-a8c7a6696f7e";

const lane = (nodeId: string, workload = "app"): LaneMetricsLane => ({
  nodeId,
  env: "production",
  workload,
});

const vec = (...rows: [string, string, string][]): PrometheusInstantResult => ({
  resultType: "vector",
  result: rows.map(([node, workload, v]) => ({
    metric: { node, env: "production", workload },
    value: [NOW / 1000, v],
  })),
});

function mimir(result: PrometheusInstantResult | Error) {
  const queries: InstantQueryParams[] = [];
  const port: LaneMetricsPrometheusReader = {
    queryInstant: async (q) => {
      queries.push(q);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { port, queries };
}

const store =
  (
    lanes: readonly LaneMetricsLane[] | Error,
    truncated = false
  ): LaneMetricsLaneReader =>
  async () => {
    if (lanes instanceof Error) throw lanes;
    return { lanes, truncated };
  };

async function compute(
  lanes: LaneMetricsLaneReader,
  prometheus: LaneMetricsPrometheusReader | null,
  env = "production"
): Promise<MetricSample> {
  const calc = createLaneMetricsCalculators({
    lanes,
    prometheus,
  })[0] as MetricCalculator;
  const controller = new AbortController();
  let calls = 0;
  const ctx: CalculatorContext = {
    window: {
      start: new Date(NOW).toISOString(),
      end: new Date(NOW).toISOString(),
    },
    signal: controller.signal,
    budget: calc.budget,
    async read(fn) {
      if (++calls > calc.budget.maxSourceCalls)
        throw new Error("source_call_budget");
      return fn(controller.signal, calc.budget);
    },
  };
  return calc.compute(calc.paramsSchema.parse({ env }), ctx);
}

describe("fleet.lane-metrics@1", () => {
  it("registers one calculator with a dash id", () => {
    const [calc] = createLaneMetricsCalculators({
      lanes: store([]),
      prometheus: null,
    });
    expect(calc?.id).toBe(LANE_METRICS_ID);
    expect(calc?.id).not.toContain("_");
  });

  it("reads 0 dark when every declared lane has up 1", async () => {
    const { port, queries } = mimir(vec([A, "app", "1"], [B, "poly", "1"]));
    const s = await compute(store([lane(A), lane(B, "poly")]), port);
    expect(s).toMatchObject({ value: 0, unit: "lanes", complete: true });
    expect(s.evidenceRefs?.[0]).toBe(
      "lanemetrics:env=production,declared=2,dark=0"
    );
    expect(queries[0]?.query).toBe(laneUpQuery("production"));
    expect(queries[0]?.query).toContain('job="node-lanes",env="production"');
  });

  it("counts a lane with up 0 and a lane with no series as dark", async () => {
    const { port } = mimir(vec([A, "app", "0"]));
    const s = await compute(
      store([lane(A), lane(A, "canary"), lane(B, "poly")]),
      port
    );
    expect(s).toMatchObject({ value: 3, complete: true });
    expect(s.evidenceRefs).toEqual([
      "lanemetrics:env=production,declared=3,dark=3",
      `dark:${A}/app`,
      `dark:${A}/canary`,
      `dark:${B}/poly`,
    ]);
  });

  it("ignores series of lanes the store does not declare", async () => {
    const { port } = mimir(vec([A, "app", "1"], [B, "gone", "0"]));
    const s = await compute(store([lane(A)]), port);
    expect(s).toMatchObject({ value: 0, complete: true });
  });

  it("reads every declared lane dark when Mimir holds no series (scraper gone)", async () => {
    const { port } = mimir(vec());
    const s = await compute(store([lane(A), lane(B, "poly")]), port);
    expect(s).toMatchObject({ value: 2, complete: true });
  });

  it("is calculator_unavailable without a Mimir reader", async () => {
    const s = await compute(store([lane(A)]), null);
    expect(s).toMatchObject({
      complete: false,
      reason: "calculator_unavailable",
    });
  });

  it("is source_failed when Mimir or the store fails", async () => {
    expect(
      await compute(store([lane(A)]), mimir(new Error("503")).port)
    ).toMatchObject({ complete: false, reason: "source_failed" });
    expect(
      await compute(store(new Error("db")), mimir(vec()).port)
    ).toMatchObject({ complete: false, reason: "source_failed" });
  });

  it("is incomplete, never 0, for a truncated read or zero lanes", async () => {
    expect(
      await compute(store([lane(A)], true), mimir(vec()).port)
    ).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
    const none = await compute(store([]), mimir(vec()).port);
    expect(none).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
    expect(none.evidenceRefs).toContain("lanemetrics:no_lanes");
  });

  it("refuses an env that is not a plain label", async () => {
    await expect(
      compute(store([lane(A)]), mimir(vec()).port, 'production"}or{x="')
    ).rejects.toThrow();
  });
});
