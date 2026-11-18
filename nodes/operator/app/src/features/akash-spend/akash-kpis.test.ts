// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/akash-spend/akash-kpis.test`
 * Purpose: Prove `compute.akash-spend@1` (task.5497) over a fake cost ledger and a stand-in rate converter:
 *   rates sum per node and account, values round to three decimals, the `nodeId` param picks one
 *   node, an unconvertible rate makes the reading incomplete (never a smaller sum), an empty ledger, an unknown
 *   node and a ledger with no active lease are unavailable (never 0), a missing reader is
 *   `calculator_unavailable`, a ledger error is `source_failed`, and evidence is capped at 20 rows.
 * Side-effects: none
 */

import type {
  CalculatorContext,
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { describe, expect, it } from "vitest";
import type { ComputeCostRate, ComputeCostReport } from "@/ports";
import {
  AKASH_SPEND_ID,
  type AkashSpendCalculatorOptions,
  createAkashSpendCalculators,
} from "./akash-kpis";

const NOW = Date.parse("2026-11-18T21:09:00.000Z");
const ACCOUNT = "akash1pinnedaccount";
const NODE_A = "11111111-1111-4111-8111-111111111111";
const NODE_B = "22222222-2222-4222-8222-222222222222";

// A stand-in converter: the real `akashUsdPerDay` is proven at the composition seam
// (bootstrap/capabilities/akash-spend.test.ts); this file imports no adapter.
const stubUsdPerDay = (r: ComputeCostRate): number | null =>
  r.denom === "usd" && r.unit === "day" ? Number(r.amount) : null;

const rate = (
  amount: string,
  unit = "day",
  denom = "usd"
): ComputeCostRate => ({
  amount,
  denom,
  unit,
});

const report = (
  nodeId: string,
  ...activeRates: ComputeCostRate[]
): ComputeCostReport => ({
  nodeId,
  allocatedIntervals: activeRates.length,
  activeIntervals: activeRates.length,
  closedIntervals: 0,
  transferred: [],
  activeRates,
});

async function compute(
  reports: readonly ComputeCostReport[] | Error | "unconfigured",
  params: Record<string, unknown> = {},
  usdPerDay: AkashSpendCalculatorOptions["usdPerDay"] = stubUsdPerDay
): Promise<{ sample: MetricSample; reads: number }> {
  const calc = createAkashSpendCalculators({
    accountId: ACCOUNT,
    readCosts:
      reports === "unconfigured"
        ? undefined
        : async () => {
            if (reports instanceof Error) throw reports;
            return reports;
          },
    usdPerDay,
  })[0] as MetricCalculator;
  const controller = new AbortController();
  let reads = 0;
  const ctx: CalculatorContext = {
    window: {
      start: new Date(NOW - 3_600_000).toISOString(),
      end: new Date(NOW).toISOString(),
    },
    signal: controller.signal,
    budget: calc.budget,
    async read(fn) {
      if (++reads > calc.budget.maxSourceCalls)
        throw new Error("source_call_budget");
      return fn(controller.signal, calc.budget);
    },
  };
  const sample = await calc.compute(calc.paramsSchema.parse(params), ctx);
  return { sample, reads };
}

describe("compute.akash-spend@1", () => {
  it("registers one dash-id calculator in USD/day with a 5 s, one-call budget", () => {
    const [calc] = createAkashSpendCalculators({
      accountId: ACCOUNT,
      readCosts: undefined,
      usdPerDay: stubUsdPerDay,
    });
    expect(calc?.id).toBe(AKASH_SPEND_ID);
    expect(calc?.id).not.toContain("_");
    expect(calc?.unit).toBe("USD/day");
    expect(calc?.budget.timeoutMs).toBe(5_000);
    expect(calc?.budget.maxSourceCalls).toBe(1);
  });

  it("reads one node's rate as its USD/day, rounded to three decimals", async () => {
    const { sample, reads } = await compute([report(NODE_A, rate("1.02841"))]);
    expect(sample).toMatchObject({
      value: 1.028,
      unit: "USD/day",
      complete: true,
    });
    expect(reads).toBe(1);
    expect(sample.sourceWatermarks).toEqual([
      { source: "akash-cost-ledger", asOf: new Date(NOW).toISOString() },
    ]);
    expect(sample.evidenceRefs[0]).toContain(`akash:account=${ACCOUNT}`);
    expect(sample.evidenceRefs).toContain(`node:${NODE_A}=1.028USD/day`);
  });

  it("sums every active lease per node and across the account", async () => {
    const { sample } = await compute([
      report(NODE_A, rate("1.5"), rate("0.25")),
      report(NODE_B, rate("3")),
    ]);
    const expected = 1.5 + 0.25 + 3;
    expect(sample.complete).toBe(true);
    expect(sample.value).toBeCloseTo(expected, 3);
    expect(sample.evidenceRefs[0]).toContain("nodes=2,leases=3");
  });

  it("returns one node's row when nodeId is given", async () => {
    const reports = [
      report(NODE_A, rate("1.02841")),
      report(NODE_B, rate("2")),
    ];
    const one = await compute(reports, { nodeId: NODE_A });
    expect(one.sample).toMatchObject({ value: 1.028, complete: true });
    expect(one.sample.evidenceRefs.join("\n")).not.toContain(NODE_B);
    expect(one.sample.evidenceRefs[0]).toContain(`node=${NODE_A}`);
  });

  it("accepts a nodeId in any case and rejects anything that is not a UUID", async () => {
    const upper = await compute([report(NODE_A, rate("1.02841"))], {
      nodeId: NODE_A.toUpperCase(),
    });
    expect(upper.sample.complete).toBe(true);
    const [calc] = createAkashSpendCalculators({
      accountId: ACCOUNT,
      readCosts: undefined,
      usdPerDay: stubUsdPerDay,
    });
    for (const bad of ["operator", "not-a-uuid", `${NODE_A}x`, "' or 1=1"])
      expect(() => calc?.paramsSchema.parse({ nodeId: bad })).toThrow();
    expect(() => calc?.paramsSchema.parse({ extra: 1 })).toThrow();
  });

  it("is incomplete, not a smaller sum, when a rate cannot be converted", async () => {
    for (const bad of [
      rate("5", "day", "uakt"),
      rate("not-a-number"),
      rate("5", "fortnight"),
    ]) {
      const { sample } = await compute([
        report(NODE_A, rate("1.02841")),
        report(NODE_B, bad),
      ]);
      expect(sample).toMatchObject({
        complete: false,
        reason: "incomplete_or_invalid_source",
      });
      expect(sample.evidenceRefs).toContain(
        `akash:unconvertible_rate=${NODE_B}`
      );
    }
  });

  it("treats a converter that yields a non-finite value as incomplete", async () => {
    const { sample } = await compute(
      [report(NODE_A, rate("1"))],
      {},
      () => Number.NaN
    );
    expect(sample).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
  });

  it("an unconvertible rate on another node does not block a node-scoped read", async () => {
    const { sample } = await compute(
      [report(NODE_A, rate("1.02841")), report(NODE_B, rate("5", "x"))],
      { nodeId: NODE_A }
    );
    expect(sample).toMatchObject({ value: 1.028, complete: true });
  });

  it("an empty ledger is unavailable, never 0", async () => {
    const { sample } = await compute([]);
    expect(sample).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
    expect(sample.evidenceRefs).toContain("akash:ledger_empty");
  });

  it("an unknown nodeId is unavailable, never 0", async () => {
    const { sample } = await compute([report(NODE_A, rate("1.02841"))], {
      nodeId: NODE_B,
    });
    expect(sample).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
    expect(sample.evidenceRefs).toContain("akash:node_not_in_ledger");
  });

  it("a ledger with no active lease is unavailable, never 0", async () => {
    const { sample } = await compute([report(NODE_A), report(NODE_B)]);
    expect(sample).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
    expect(sample.evidenceRefs).toContain("akash:no_active_leases");
  });

  it("a missing reader is calculator_unavailable and reads nothing", async () => {
    const { sample, reads } = await compute("unconfigured");
    expect(sample).toMatchObject({
      complete: false,
      reason: "calculator_unavailable",
    });
    expect(sample.evidenceRefs).toContain("akash:source_unconfigured");
    expect(reads).toBe(0);
  });

  it("a ledger error is source_failed", async () => {
    const { sample } = await compute(new Error("connection refused"));
    expect(sample).toMatchObject({ complete: false, reason: "source_failed" });
    expect(JSON.stringify(sample)).not.toContain("connection refused");
  });

  it("caps evidence at 20 rows, costliest first, with a truncation marker", async () => {
    const reports = Array.from({ length: 23 }, (_, i) =>
      report(
        `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        rate(String(10 + i))
      )
    );
    const { sample } = await compute(reports);
    const rows = sample.evidenceRefs.filter((r) => r.startsWith("node:"));
    expect(rows).toHaveLength(20);
    expect(rows[0]).toContain("00000000-0000-4000-8000-000000000022");
    expect(sample.evidenceRefs).toContain("akash:rows_truncated=3");
    // The value still covers all 23 nodes, not just the listed 20.
    const all = reports.reduce(
      (s, r) => s + Number((r.activeRates[0] as ComputeCostRate).amount),
      0
    );
    expect(sample.value).toBeCloseTo(all, 3);
    expect(sample.evidenceRefs[0]).toContain("nodes=23");
  });

  it("does not mark evidence truncated at exactly 20 rows", async () => {
    const reports = Array.from({ length: 20 }, (_, i) =>
      report(
        `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        rate("10")
      )
    );
    const { sample } = await compute(reports);
    expect(sample.evidenceRefs.some((r) => r.includes("truncated"))).toBe(
      false
    );
  });
});
