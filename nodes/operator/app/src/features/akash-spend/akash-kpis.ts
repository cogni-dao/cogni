// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/akash-spend/akash-kpis`
 * Purpose: The operator's node-local goal-metric calculator for its own Akash run cost (task.5497):
 *   `compute.akash-spend@1` reports `cost_per_day` (USD/day), the sum of every active lease rate in the
 *   operator's Akash cost ledger converted to a daily price, for the whole pinned account or for one node.
 *   It makes the fleet's known run cost a live goal reading (goal-fleet-pays-itself) instead of a hand-run script.
 *   Registered through `@cogni-dao/metrics` `createGoalMetrics({ nodeCalculators })`.
 * Scope: Pure aggregation and the calculator object. The only IO is the injected `readCosts` (the operator's own
 *   `akashSpendReader.reportByNode`, the same in-process read as GET /api/v1/compute/balances), called through
 *   `ctx.read`. The rate-to-USD conversion is injected too, so this file imports no adapter and owns no block-time
 *   or uact-to-USD literal.
 * Invariants:
 *   - ONE_CONVERSION: a rate becomes USD/day only through the injected `usdPerDay` (`akashUsdPerDay`, which owns
 *     the 5.884 s block time and the uact-as-USD-micro convention). No numeric literal for either lives here.
 *   - UNCONVERTIBLE_IS_INCOMPLETE: a rate `usdPerDay` cannot convert makes the whole reading
 *     `incomplete_or_invalid_source`. It is never skipped, because a skipped rate is a smaller sum.
 *   - ABSENCE_IS_UNAVAILABLE: an empty report, an unknown `nodeId`, or a selection with no active lease is
 *     `incomplete_or_invalid_source`, never 0.
 *   - SOURCE_ERROR_IS_UNAVAILABLE: a ledger error or timeout is `source_failed`; a missing reader (no
 *     `AKASH_ACTUATOR_ACCOUNT_ID`) is `calculator_unavailable`. Neither is a fake 0.
 *   - NODE_ID_IS_UUID: the optional `nodeId` param is a strict UUID, so no free text reaches the filter or evidence.
 *   - EVIDENCE_IS_CAPPED: evidence is the account id plus at most 20 per-node rows with a truncation marker; the
 *     value time is `ctx.window.end`.
 *   - IDS_USE_DASHES: the calculator id matches `MetricSpecSchema.calculatorId` (no underscores).
 * Side-effects: none (the calculator calls the injected reader)
 * Links: bootstrap/capabilities/goal-metrics.ts, adapters/server/finance/operator-finance.adapter.ts (akashUsdPerDay),
 *   features/substrate-health/substrate-kpis.ts, task.5497
 * @public
 */

import type {
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { z } from "zod";
import type { ComputeCostRate, ComputeCostReport } from "@/ports";

export const AKASH_SPEND_ID = "compute.akash-spend@1";
export const AKASH_SPEND_OUTPUTS = ["cost_per_day"] as const;
const UNIT = "USD/day";

/** Evidence lists at most this many per-node rows. */
const MAX_EVIDENCE = 20;
/** Most node reports one read may carry before it counts as an invalid source. */
const MAX_REPORTS = 1_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const paramsSchema = z.strictObject({
  output: z.enum(AKASH_SPEND_OUTPUTS).default("cost_per_day"),
  nodeId: z.string().regex(UUID).optional(),
});

/** Round at three decimals; float noise is removed at 1e-6 first. */
const round3 = (x: number) => Math.round(Math.round(x * 1e6) / 1e3) / 1e3;

export interface AkashSpendCalculatorOptions {
  /** The pinned Akash account (`AKASH_ACTUATOR_ACCOUNT_ID`); evidence names it. */
  readonly accountId: string | undefined;
  /** The operator's cost-ledger read; absent when no account is pinned. */
  readonly readCosts:
    | (() => Promise<readonly ComputeCostReport[]>)
    | undefined
    | null;
  /** One active rate as USD per day, or null when it cannot be converted (`akashUsdPerDay`). */
  readonly usdPerDay: (rate: ComputeCostRate) => number | null;
}

export function createAkashSpendCalculators({
  accountId,
  readCosts,
  usdPerDay,
}: AkashSpendCalculatorOptions): MetricCalculator[] {
  const akashSpend: MetricCalculator = {
    id: AKASH_SPEND_ID,
    unit: UNIT,
    display: "progress",
    paramsSchema,
    budget: {
      timeoutMs: 5_000,
      maxSourceCalls: 1,
      maxRows: MAX_REPORTS,
      maxResponseBytes: 1_048_576,
    },
    async compute(params, ctx) {
      const p = paramsSchema.parse(params);
      const asOf = new Date(ctx.window.end).toISOString();
      const head = [
        `akash:account=${accountId ?? "unpinned"}`,
        ...(p.nodeId ? [`node=${p.nodeId}`] : []),
      ].join(",");
      const unknown = (
        reason: NonNullable<MetricSample["reason"]>,
        ...extra: string[]
      ): MetricSample => ({
        value: 0,
        unit: UNIT,
        complete: false,
        reason,
        sourceWatermarks: [{ source: "akash-cost-ledger", asOf }],
        evidenceRefs: [head, ...extra],
      });

      if (!readCosts)
        return unknown("calculator_unavailable", "akash:source_unconfigured");

      let reports: readonly ComputeCostReport[];
      try {
        reports = await ctx.read((signal) => {
          signal.throwIfAborted();
          return readCosts();
        });
      } catch {
        return unknown("source_failed");
      }

      if (reports.length > MAX_REPORTS)
        return unknown(
          "incomplete_or_invalid_source",
          `akash:reports>${MAX_REPORTS}`
        );
      const wanted = p.nodeId?.toLowerCase();
      const selected = wanted
        ? reports.filter((r) => r.nodeId.toLowerCase() === wanted)
        : reports;
      // ABSENCE_IS_UNAVAILABLE: nothing in the ledger (or no such node) is not a cost of 0.
      if (selected.length === 0)
        return unknown(
          "incomplete_or_invalid_source",
          p.nodeId ? "akash:node_not_in_ledger" : "akash:ledger_empty"
        );

      const rows: { nodeId: string; usdPerDay: number }[] = [];
      let leases = 0;
      for (const report of selected) {
        let nodeUsd = 0;
        for (const rate of report.activeRates) {
          const usd = usdPerDay(rate);
          // UNCONVERTIBLE_IS_INCOMPLETE: never drop a rate and report a smaller sum.
          if (usd === null || !Number.isFinite(usd))
            return unknown(
              "incomplete_or_invalid_source",
              `akash:unconvertible_rate=${report.nodeId}`
            );
          nodeUsd += usd;
          leases += 1;
        }
        rows.push({ nodeId: report.nodeId, usdPerDay: nodeUsd });
      }
      if (leases === 0)
        return unknown(
          "incomplete_or_invalid_source",
          "akash:no_active_leases"
        );

      const total = rows.reduce((sum, r) => sum + r.usdPerDay, 0);
      // Costliest first; ties break on node id for stable evidence.
      rows.sort(
        (a, b) => b.usdPerDay - a.usdPerDay || (a.nodeId < b.nodeId ? -1 : 1)
      );
      const omitted = rows.length - MAX_EVIDENCE;
      return {
        value: round3(total),
        unit: UNIT,
        complete: true,
        sourceWatermarks: [{ source: "akash-cost-ledger", asOf }],
        evidenceRefs: [
          `${head},nodes=${rows.length},leases=${leases}`,
          ...rows
            .slice(0, MAX_EVIDENCE)
            .map((r) => `node:${r.nodeId}=${round3(r.usdPerDay)}${UNIT}`),
          ...(omitted > 0 ? [`akash:rows_truncated=${omitted}`] : []),
        ],
      };
    },
  };
  return [akashSpend];
}
