// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/finance/operator-finance.adapter`
 * Purpose: Shared finance helpers plus the Akash hosting rows (one operator-covered USD/day line per node from the stored lease price).
 * Scope: Read-only projection and cadence conversion; no new storage, no FX between currencies, no payment history inference.
 *   Vendor readers live beside this file (akash-credit, cherry-finance, grafana-overage, domain-expiry).
 * Invariants: READERS_NEVER_THROW. Akash burn is converted from the exact on-chain lease price with the measured chain cadence
 *   when supplied, else 5.884 s/block (the parameter `goal-fleet-pays-itself` uses); uact is read as USD micro, never FX.
 *   A node is one row. Cost lines with a measured burn and no balance are INFO (no runway to grade).
 * Side-effects: IO through injected compute ports only.
 * Links: scripts/money-plane-snapshot.mjs, https://cognidao.org/knowledge/money-plane-registry, https://cognidao.org/work/items/task.5347
 * @public
 */
import {
  type MoneyPlaneRow,
  type PayAction,
  type PlaneReader,
  unknownRow,
} from "@cogni/money-plane";

import type {
  ComputeCostRate,
  ComputeCostReport,
} from "@/ports/compute-cost.port";
import { FALLBACK_BLOCKS_PER_DAY } from "./akash-credit.reader";

export { AKASH_SECONDS_PER_BLOCK } from "./akash-credit.reader";
export const AKASH_RATE_SOURCE = "On-chain lease price · 5.884 s/block";
export const AKASH_HOSTING_PLANE = "akash:fleet";
const DAYS_PER_MONTH = 30.4;
const UACT_PER_USD = 1e6;

export function unavailableFinanceReader(
  plane: string,
  label: string,
  kind: MoneyPlaneRow["kind"],
  detail: string,
  reasonCode: MoneyPlaneRow["reasonCode"] = "unconfigured",
  payer?: string,
  payAction?: PayAction,
  beneficiary?: string
): PlaneReader {
  const withAction = payAction === undefined ? {} : { payAction };
  return {
    plane,
    label,
    kind,
    ...withAction,
    async read() {
      return {
        ...unknownRow({
          plane,
          label,
          kind,
          reasonCode: reasonCode ?? "unconfigured",
          observedAt: new Date().toISOString(),
          detail,
        }),
        ...(payer ? { payer } : {}),
        ...(beneficiary ? { beneficiary } : {}),
        ...withAction,
      };
    },
  };
}

/** Exact uact lease price → USD per day via the rate's stated cadence; null when not convertible. */
export function akashUsdPerDay(
  rate: ComputeCostRate,
  blocksPerDay = FALLBACK_BLOCKS_PER_DAY
): number | null {
  if (rate.denom !== "uact") return null;
  const amount = Number(rate.amount);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const perDay =
    rate.unit === "block"
      ? amount * blocksPerDay
      : rate.unit === "day"
        ? amount
        : rate.unit === "month"
          ? amount / DAYS_PER_MONTH
          : null;
  return perDay === null ? null : perDay / UACT_PER_USD;
}

/** One operator-covered hosting row per node; the exact native price stays on the row for the Source dialog. */
export function akashHostingRow(
  report: ComputeCostReport,
  at: string,
  blocksPerDay: number | null = null
): MoneyPlaneRow {
  const plane = `akash:${report.nodeId}`;
  const label = `Akash · ${report.nodeId}`;
  const bpd =
    blocksPerDay !== null && Number.isFinite(blocksPerDay) && blocksPerDay > 0
      ? blocksPerDay
      : FALLBACK_BLOCKS_PER_DAY;
  const transfer = report.transferred.find((t) => t.denom === "uact");
  const attribution = {
    payer: "Operator",
    beneficiary: report.nodeId,
    coverage: "operator-covered" as const,
    ...(transfer
      ? {
          cumulativeVendorTransfer: {
            amount: transfer.amount,
            currency: transfer.denom,
          },
        }
      : {}),
  };
  const priced = report.activeRates.flatMap((rate) => {
    const usd = akashUsdPerDay(rate, bpd);
    return usd === null ? [] : [{ rate, usd }];
  });
  if (priced.length === 0) {
    return {
      ...unknownRow({
        plane,
        label,
        kind: "usage",
        reasonCode: report.activeRates.length ? "unreadable" : "no_leases",
        observedAt: at,
        detail: report.activeRates.length
          ? "lease price not in USD credit"
          : "no active lease",
      }),
      ...attribution,
    };
  }
  const only = priced.length === 1 ? priced[0]?.rate : undefined;
  const per = only?.unit;
  return {
    plane,
    label,
    kind: "usage",
    balance: null,
    currency: "USD",
    burnPerDay: priced.reduce((sum, { usd }) => sum + usd, 0),
    runwayDays: null,
    grade: "INFO",
    observedAt: at,
    source:
      blocksPerDay === null
        ? AKASH_RATE_SOURCE
        : `On-chain lease price · ${Math.round(bpd).toLocaleString("en-US")} blocks/day (measured)`,
    // The cost ledger stores the accepted price, not when the chain was last observed.
    sourceObservedAt: null,
    freshness: "unknown",
    ...attribution,
    ...(only && (per === "block" || per === "day" || per === "month")
      ? { nativeRate: { amount: only.amount, currency: only.denom, per } }
      : {}),
    ...(priced.length > 1 ? { detail: `${priced.length} active leases` } : {}),
  };
}

/** Read the stored fleet cost report once under a budget; null means the ledger could not be read. */
export async function readAkashReports(
  read: (() => Promise<readonly ComputeCostReport[]>) | undefined,
  timeoutMs = 5000
): Promise<readonly ComputeCostReport[] | null> {
  if (!read) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Cost evidence timeout")),
          timeoutMs
        );
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One reader per node, or one UNKNOWN fleet row when the ledger is unreadable or empty. */
export function akashHostingReaders(
  reports: readonly ComputeCostReport[] | null,
  at: string,
  blocksPerDay: number | null = null
): PlaneReader[] {
  if (reports === null) {
    return [
      unavailableFinanceReader(
        AKASH_HOSTING_PLANE,
        "Akash hosting",
        "usage",
        "cost ledger unavailable",
        "unreadable",
        "Operator"
      ),
    ];
  }
  if (reports.length === 0) {
    return [
      unavailableFinanceReader(
        AKASH_HOSTING_PLANE,
        "Akash hosting",
        "usage",
        "no nodes with cost evidence",
        "no_leases",
        "Operator"
      ),
    ];
  }
  return reports.map((report) => {
    const row = akashHostingRow(report, at, blocksPerDay);
    return {
      plane: row.plane,
      label: row.label,
      kind: row.kind,
      read: async () => row,
    };
  });
}

/**
 * The shared grading floor reserves INFO for wallets. An operator cost line that has a measured
 * burn and no balance has nothing to divide, so it is INFO (no runway) rather than UNKNOWN.
 */
export function restoreCostLineGrades<Row extends MoneyPlaneRow>(
  rows: readonly Row[]
): Row[] {
  return rows.map((row) =>
    row.kind === "usage" &&
    row.grade === "UNKNOWN" &&
    row.reasonCode === undefined &&
    row.burnPerDay !== null &&
    row.balance === null
      ? { ...row, grade: "INFO" }
      : row
  );
}
