// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/ai-health/ai-kpis.test`
 * Purpose: Prove `ai.run-errors@1` (task.5468) over a fake Loki reader: run and chat rate math, floors, a zero
 *   denominator is unknown, a Loki failure is `source_failed`, a missing reader is `calculator_unavailable` + `ai:source_unconfigured`,
 *   evidence is failure-sorted and bounded, and the queries carry only the validated env and hours.
 * Side-effects: none
 */

import type {
  CalculatorContext,
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { describe, expect, it } from "vitest";
import type {
  LokiInstantQuery,
  LokiInstantSample,
  LokiReaderPort,
} from "@/ports";
import {
  chatQuery,
  createAiCalculators,
  percentFloor3,
  RUN_ERRORS_ID,
  runQuery,
} from "./ai-kpis";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const N1 = "11111111-1111-4111-8111-111111111111";
const N2 = "22222222-2222-4222-8222-222222222222";

function reader(samples: LokiInstantSample[] | Error) {
  const queries: LokiInstantQuery[] = [];
  const port: LokiReaderPort = {
    queryRange: async () => [],
    queryInstant: async (q) => {
      queries.push(q);
      if (samples instanceof Error) throw samples;
      return samples;
    },
  };
  return { port, queries };
}

const run = (node: string | undefined, ok: boolean, code: string, v: number) =>
  ({
    labels: {
      ...(node ? { node } : {}),
      ok: String(ok),
      errorCode: code,
    },
    value: v,
  }) satisfies LokiInstantSample;
const chat = (node: string, msg: string, v: number) =>
  ({ labels: { node, msg }, value: v }) satisfies LokiInstantSample;

async function compute(
  loki: LokiReaderPort | undefined,
  params: Record<string, unknown>
): Promise<MetricSample> {
  const calc = createAiCalculators({ loki })[0] as MetricCalculator;
  const controller = new AbortController();
  let calls = 0;
  const ctx: CalculatorContext = {
    window: {
      start: new Date(NOW - 3_600_000).toISOString(),
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

const p = (output: string, env = "production", hours = 24) => ({
  env,
  output,
  hours,
});

const RUNS = [
  run(N1, true, "", 90),
  run(N1, false, "timeout", 6),
  run(N1, false, "rate_limited", 2),
  run(N2, true, "", 100),
  run(N2, false, "timeout", 2),
];

describe("ai.run-errors@1 runs", () => {
  it("computes the run counts and the floored rate", async () => {
    const { port } = reader(RUNS);
    expect(await compute(port, p("runs"))).toMatchObject({
      value: 200,
      unit: "runs",
      complete: true,
    });
    expect(await compute(port, p("run_failed"))).toMatchObject({
      value: 10,
      unit: "runs",
    });
    // 10 / 200 = 5%
    expect(await compute(port, p("run_error_rate"))).toMatchObject({
      value: 5,
      unit: "%",
      complete: true,
    });
  });

  it("floors the rate to three decimals", async () => {
    const { port } = reader([run(N1, false, "x", 1), run(N1, true, "", 2)]);
    // 1/3 = 33.3333..% -> 33.333; never rounds up to 33.334
    expect((await compute(port, p("run_error_rate"))).value).toBe(33.333);
    expect(percentFloor3(2, 3)).toBe(66.666);
  });

  it("orders evidence by failures, with codes, and a header", async () => {
    const { port } = reader(RUNS);
    const s = await compute(port, p("run_error_rate", "preview", 6));
    expect(s.evidenceRefs).toEqual([
      "ai:env=preview,hours=6,runs=200,failed=10",
      `node:${N1}:failed=8/98:codes=timeout=6|rate_limited=2`,
      `node:${N2}:failed=2/102:codes=timeout=2`,
    ]);
  });

  it("labels a series without a node as unknown and bounds evidence at 20", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      run(`n${String(i).padStart(2, "0")}`, false, "e", i + 1)
    );
    const { port } = reader([run(undefined, false, "boom", 100), ...many]);
    const s = await compute(port, p("run_failed"));
    expect(s.evidenceRefs).toHaveLength(21);
    expect(s.evidenceRefs?.[1]).toBe(
      "node:unknown:failed=100/100:codes=boom=100"
    );
    expect(s.evidenceRefs?.[2]).toBe("node:n29:failed=30/30:codes=e=30");
  });

  it("queries Loki once, instant, at the window end", async () => {
    const { port, queries } = reader(RUNS);
    await compute(port, p("runs", "candidate-a", 12));
    expect(queries).toEqual([
      {
        query: runQuery("candidate-a", 12),
        timeNs: `${NOW}000000`,
      },
    ]);
    expect(queries[0]?.query).toContain(
      '{env="candidate-a",service=~"app.*|poly.*"}'
    );
    expect(queries[0]?.query).toContain("[12h]");
  });
});

describe("ai.run-errors@1 chat turns", () => {
  const CHAT = [
    chat(N1, "ai.chat_stream_closed", 40),
    chat(N1, "ai.chat_stream_final_error", 3),
    chat(N2, "ai.chat_stream_closed", 10),
    chat(N2, "ai.chat_stream_final_error", 1),
  ];
  it("computes turns and the final-error rate", async () => {
    const { port, queries } = reader(CHAT);
    expect(await compute(port, p("chat_turns"))).toMatchObject({
      value: 50,
      unit: "turns",
      complete: true,
    });
    // 4 / 50 = 8%
    expect(await compute(port, p("chat_error_rate"))).toMatchObject({
      value: 8,
      unit: "%",
    });
    expect(queries[0]?.query).toBe(chatQuery("production", 24));
  });

  it("orders chat evidence by final errors", async () => {
    const { port } = reader(CHAT);
    const s = await compute(port, p("chat_error_rate"));
    expect(s.evidenceRefs).toEqual([
      "ai:env=production,hours=24,chat_turns=50,final_error=4",
      `node:${N1}:final_error=3/40`,
      `node:${N2}:final_error=1/10`,
    ]);
  });
});

describe("ai.run-errors@1 unknown is a result", () => {
  it("a zero denominator is unknown for a rate, never 0%", async () => {
    const { port } = reader([]);
    const s = await compute(port, p("run_error_rate"));
    expect(s).toMatchObject({
      complete: false,
      reason: "zero_denominator",
      unit: "%",
    });
    expect(await compute(port, p("chat_error_rate"))).toMatchObject({
      complete: false,
      reason: "zero_denominator",
    });
  });

  it("a zero count with no traffic is a complete zero for count outputs", async () => {
    const { port } = reader([]);
    expect(await compute(port, p("runs"))).toMatchObject({
      value: 0,
      complete: true,
    });
  });

  it("a Loki failure is source_failed and leaks nothing", async () => {
    const { port } = reader(new Error("loki query failed: HTTP 500 secret"));
    const s = await compute(port, p("run_error_rate"));
    expect(s).toMatchObject({ complete: false, reason: "source_failed" });
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  it("no Loki reader is unavailable with an unconfigured evidence ref", async () => {
    expect(await compute(undefined, p("runs"))).toMatchObject({
      complete: false,
      reason: "calculator_unavailable",
      evidenceRefs: ["ai:env=production,hours=24", "ai:source_unconfigured"],
    });
  });
});

describe("ai.run-errors@1 contract", () => {
  const calc = createAiCalculators({ loki: undefined })[0] as MetricCalculator;
  it("has a dashed id and strict params", () => {
    expect(calc.id).toBe(RUN_ERRORS_ID);
    expect(calc.id).not.toContain("_");
    expect(() => calc.paramsSchema.parse(p("runs", "free text"))).toThrow();
    expect(() => calc.paramsSchema.parse(p("runs", "production", 0))).toThrow();
    expect(() =>
      calc.paramsSchema.parse(p("runs", "production", 169))
    ).toThrow();
    expect(() => calc.paramsSchema.parse({ ...p("runs"), extra: 1 })).toThrow();
  });
  it("reports unit and display by output", () => {
    expect(calc.unitFor?.(p("run_error_rate"))).toBe("%");
    expect(calc.unitFor?.(p("runs"))).toBe("runs");
    expect(calc.unitFor?.(p("chat_turns"))).toBe("turns");
    expect(calc.displayFor?.(p("chat_error_rate"))).toBe("slo");
    expect(calc.displayFor?.(p("run_failed"))).toBe("volume");
  });
  it("declares a small budget", () => {
    expect(calc.budget.maxSourceCalls).toBe(2);
    expect(calc.budget.timeoutMs).toBeLessThanOrEqual(30_000);
  });
});
