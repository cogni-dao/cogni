// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/substrate-health/substrate-kpis.test`
 * Purpose: Prove `substrate.host-pressure@1` (bug.5613) over a fake Mimir reader: a healthy host reads in range,
 *   a starved host breaches, the worst host wins, a missing series (above all the kine exporter) is an incomplete
 *   sample and never 0, a Mimir error is `source_failed`, a missing reader is `calculator_unavailable`, rounding
 *   goes toward breach, and queries carry only the validated env.
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
  createSubstrateCalculators,
  HOST_PRESSURE_ID,
  OUTPUTS,
  type SubstratePrometheusReader,
} from "./substrate-kpis";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");

const vec = (...rows: [string, string][]): PrometheusInstantResult => ({
  resultType: "vector",
  result: rows.map(([instance, v]) => ({
    metric: { instance, env: "candidate-a" },
    value: [NOW / 1000, v],
  })),
});

function reader(result: PrometheusInstantResult | Error) {
  const queries: InstantQueryParams[] = [];
  const port: SubstratePrometheusReader = {
    queryInstant: async (q) => {
      queries.push(q);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { port, queries };
}

async function compute(
  prometheus: SubstratePrometheusReader | undefined | null,
  params: Record<string, unknown>
): Promise<MetricSample> {
  const calc = createSubstrateCalculators({
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
  return calc.compute(calc.paramsSchema.parse(params), ctx);
}

const p = (output: string, env = "candidate-a") => ({ env, output });

describe("substrate.host-pressure@1", () => {
  it("registers one calculator with a dash id and per-output units", () => {
    const [calc] = createSubstrateCalculators({ prometheus: null });
    expect(calc?.id).toBe(HOST_PRESSURE_ID);
    expect(calc?.id).not.toContain("_");
    expect(calc?.unitFor?.(p("io_pressure"))).toBe("%");
    expect(calc?.unitFor?.(p("swap_in"))).toBe("pages/s");
    expect(calc?.unitFor?.(p("memory_available"))).toBe("%");
    expect(calc?.unitFor?.(p("kine_bytes"))).toBe("bytes");
  });

  it("reads a healthy host", async () => {
    expect(
      await compute(reader(vec(["vm-a", "0.001"])).port, p("io_pressure"))
    ).toMatchObject({ value: 0.1, unit: "%", complete: true });
    expect(
      await compute(reader(vec(["vm-a", "0"])).port, p("swap_in"))
    ).toMatchObject({ value: 0, unit: "pages/s", complete: true });
    expect(
      await compute(reader(vec(["vm-a", "52.4"])).port, p("memory_available"))
    ).toMatchObject({ value: 52.4, unit: "%", complete: true });
    expect(
      await compute(reader(vec(["vm-a", "104857600"])).port, p("kine_bytes"))
    ).toMatchObject({ value: 104857600, unit: "bytes", complete: true });
  });

  it("reads the 2026-11-10 candidate-a starvation as a breach on every output", async () => {
    expect(
      await compute(reader(vec(["cand", "0.29"])).port, p("io_pressure"))
    ).toMatchObject({ value: 29, complete: true });
    expect(
      await compute(reader(vec(["cand", "3700"])).port, p("swap_in"))
    ).toMatchObject({ value: 3700, complete: true });
    expect(
      await compute(reader(vec(["cand", "13.6"])).port, p("memory_available"))
    ).toMatchObject({ value: 13.6, complete: true });
    // 6.57 GB state.db against a 512 MB target.
    expect(
      await compute(reader(vec(["cand", "6570000000"])).port, p("kine_bytes"))
    ).toMatchObject({ value: 6_570_000_000, complete: true });
  });

  it("takes the worst host: max for pressure, min for memory available", async () => {
    const io = await compute(
      reader(vec(["a", "0.01"], ["b", "0.40"], ["c", "0.02"])).port,
      p("io_pressure")
    );
    expect(io.value).toBe(40);
    expect(io.evidenceRefs[0]).toContain("hosts=3,worst=b");
    expect(io.evidenceRefs[1]).toBe("host:b=40%");

    const mem = await compute(
      reader(vec(["a", "52"], ["b", "11.5"], ["c", "30"])).port,
      p("memory_available")
    );
    expect(mem.value).toBe(11.5);
    expect(mem.evidenceRefs[0]).toContain("worst=b");
  });

  it("rounds toward breach", async () => {
    // 10.0004% of wall time must not read as 10.
    expect(
      await compute(reader(vec(["a", "0.100004"])).port, p("io_pressure"))
    ).toMatchObject({ value: 10.001 });
    // 14.9996% available must not read as 15.
    expect(
      await compute(reader(vec(["a", "14.9996"])).port, p("memory_available"))
    ).toMatchObject({ value: 14.999 });
    expect(
      await compute(reader(vec(["a", "536870912.4"])).port, p("kine_bytes"))
    ).toMatchObject({ value: 536870913 });
  });

  it("treats a missing kine series as incomplete with a distinct evidence ref, never 0", async () => {
    const s = await compute(reader(vec()).port, p("kine_bytes", "production"));
    expect(s).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
    expect(s.evidenceRefs).toContain("substrate:kine_exporter_absent");
    expect(s.evidenceRefs).toContain(
      "substrate:series=node_k3s_kine_state_db_bytes"
    );
  });

  it("treats a missing host series as incomplete for the other outputs", async () => {
    for (const output of ["io_pressure", "swap_in", "memory_available"]) {
      const s = await compute(reader(vec()).port, p(output));
      expect(s).toMatchObject({
        complete: false,
        reason: "incomplete_or_invalid_source",
      });
      expect(s.evidenceRefs).toContain("substrate:series_missing");
      expect(s.evidenceRefs).not.toContain("substrate:kine_exporter_absent");
    }
  });

  it("treats NaN and Inf values as incomplete, never a number", async () => {
    for (const bad of ["NaN", "+Inf"]) {
      const s = await compute(
        reader(vec(["a", "0.1"], ["b", bad])).port,
        p("memory_available")
      );
      expect(s).toMatchObject({
        complete: false,
        reason: "incomplete_or_invalid_source",
      });
      expect(s.evidenceRefs).toContain("substrate:non_finite_value");
    }
  });

  it("treats a Mimir error as source_failed, never 0", async () => {
    const s = await compute(
      reader(new Error("Mimir query failed: 502 Bad Gateway")).port,
      p("io_pressure")
    );
    expect(s).toMatchObject({
      complete: false,
      reason: "source_failed",
      value: 0,
    });
    expect(JSON.stringify(s)).not.toContain("502");
  });

  it("treats a missing reader as calculator_unavailable with a source_unconfigured ref", async () => {
    for (const port of [null, undefined]) {
      const s = await compute(port, p("kine_bytes"));
      expect(s).toMatchObject({
        complete: false,
        reason: "calculator_unavailable",
      });
      expect(s.evidenceRefs).toContain("substrate:source_unconfigured");
    }
  });

  it("makes one bounded query per reading, evaluated at the window end, with only the validated env", async () => {
    const { port, queries } = reader(vec(["a", "1"]));
    await compute(port, p("io_pressure", "candidate-a"));
    expect(queries).toHaveLength(1);
    expect(queries[0]?.time?.getTime()).toBe(NOW);
    expect(queries[0]?.signal).toBeDefined();
    expect(queries[0]?.query).toBe(
      'max by (instance) (rate(node_pressure_io_waiting_seconds_total{env="candidate-a"}[5m]))'
    );
    expect(OUTPUTS.memory_available.query("production")).toContain(
      'node_memory_MemTotal_bytes{env="production"}'
    );
  });

  it("rejects an env or output that could inject into PromQL", () => {
    const [calc] = createSubstrateCalculators({ prometheus: null });
    expect(
      calc?.paramsSchema.safeParse(p("io_pressure", 'x"} or vector(1) #'))
        .success
    ).toBe(false);
    expect(calc?.paramsSchema.safeParse(p("disk")).success).toBe(false);
    expect(
      calc?.paramsSchema.safeParse({ ...p("kine_bytes"), extra: 1 }).success
    ).toBe(false);
  });

  it("bounds evidence to the worst 20 hosts", async () => {
    const rows = Array.from(
      { length: 30 },
      (_, i) =>
        [`h${String(i).padStart(2, "0")}`, String(i / 100)] as [string, string]
    );
    const s = await compute(reader(vec(...rows)).port, p("swap_in"));
    expect(s.value).toBe(0.29);
    // head line plus 20 hosts.
    expect(s.evidenceRefs).toHaveLength(21);
    expect(s.evidenceRefs[1]).toBe("host:h29=0.29pages/s");
  });
});
