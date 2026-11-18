// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/akash-spend.test`
 * Purpose: Prove the composition seam of `compute.akash-spend@1` (task.5497): the operator's
 *   `akashSpendReader` is bound to the calculator with the shared `akashUsdPerDay`, so 70.031281 uact/block reads
 *   about 1.028 USD/day, a rate the shared converter refuses makes the reading incomplete (never a smaller sum),
 *   and an unpinned account (no reader) is `calculator_unavailable`.
 * Side-effects: none
 */

import type {
  CalculatorContext,
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { describe, expect, it } from "vitest";
import type { ComputeCostRate, ComputeCostReport } from "@/ports";
import { createOperatorAkashSpendCalculators } from "./goal-metrics";

const NOW = Date.parse("2026-11-18T21:09:00.000Z");
const NODE = "11111111-1111-4111-8111-111111111111";

const report = (...activeRates: ComputeCostRate[]): ComputeCostReport => ({
  nodeId: NODE,
  allocatedIntervals: activeRates.length,
  activeIntervals: activeRates.length,
  closedIntervals: 0,
  transferred: [],
  activeRates,
});

async function compute(
  reader: Parameters<typeof createOperatorAkashSpendCalculators>[0],
  params: Record<string, unknown> = {}
): Promise<MetricSample> {
  const calc = createOperatorAkashSpendCalculators(
    reader
  )[0] as MetricCalculator;
  const controller = new AbortController();
  const ctx: CalculatorContext = {
    window: {
      start: new Date(NOW - 3_600_000).toISOString(),
      end: new Date(NOW).toISOString(),
    },
    signal: controller.signal,
    budget: calc.budget,
    read: (fn) => fn(controller.signal, calc.budget),
  };
  return calc.compute(calc.paramsSchema.parse(params), ctx);
}

const pinned = (...reports: ComputeCostReport[]) => ({
  accountId: "akash1pinnedaccount",
  reportByNode: async () => reports,
});

describe("compute.akash-spend@1 composition", () => {
  it("reads 70.031281 uact/block as about 1.028 USD/day", async () => {
    const sample = await compute(
      pinned(report({ amount: "70.031281", denom: "uact", unit: "block" }))
    );
    expect(sample).toMatchObject({
      value: 1.028,
      unit: "USD/day",
      complete: true,
    });
    expect(sample.evidenceRefs[0]).toContain(
      "akash:account=akash1pinnedaccount"
    );
    expect(sample.evidenceRefs).toContain(`node:${NODE}=1.028USD/day`);
  });

  it("is incomplete when the shared converter refuses a rate", async () => {
    for (const bad of [
      { amount: "5", denom: "uakt", unit: "block" },
      { amount: "-3", denom: "uact", unit: "block" },
      { amount: "5", denom: "uact", unit: "fortnight" },
    ]) {
      const sample = await compute(
        pinned(
          report({ amount: "70.031281", denom: "uact", unit: "block" }, bad)
        )
      );
      expect(sample).toMatchObject({
        complete: false,
        reason: "incomplete_or_invalid_source",
      });
    }
  });

  it("an unpinned account is calculator_unavailable", async () => {
    expect(await compute(undefined)).toMatchObject({
      complete: false,
      reason: "calculator_unavailable",
    });
  });

  it("a ledger failure is source_failed", async () => {
    const sample = await compute({
      accountId: "akash1pinnedaccount",
      reportByNode: async () => {
        throw new Error("db down");
      },
    });
    expect(sample).toMatchObject({ complete: false, reason: "source_failed" });
  });
});
