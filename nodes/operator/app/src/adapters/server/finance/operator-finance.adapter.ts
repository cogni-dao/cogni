// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/finance/operator-finance.adapter`
 * Purpose: Project existing stored compute cost evidence into shared finance readers.
 * Scope: Read-only projection; no new storage, currency conversion or payment history inference.
 * Invariants: Every native rate/transfer group retained; transfers attached once per denomination.
 * Side-effects: IO through injected compute ports only.
 * Links: https://cognidao.org/work/items/task.5347
 * @public
 */
import {
  type CostRateEvidence,
  type MoneyPlaneRow,
  type PlaneReader,
  unknownRow,
} from "@cogni/money-plane";

import type { ComputeCostReport } from "@/ports/compute-cost.port";

export function unavailableFinanceReader(
  plane: string,
  label: string,
  kind: MoneyPlaneRow["kind"],
  detail: string
): PlaneReader {
  return {
    plane,
    label,
    kind,
    async read() {
      return {
        ...unknownRow({
          plane,
          label,
          kind,
          reasonCode: "unconfigured",
          observedAt: new Date().toISOString(),
          detail,
        }),
        source: "Not connected",
        sourceObservedAt: null,
        freshness: "unknown",
        payer: kind === "wallet" ? "Not established" : "Operator DAO",
        beneficiary: kind === "wallet" ? "Not established" : "Fleet",
        coverage: kind === "wallet" ? "unknown" : "operator-covered",
      };
    },
  };
}

/** Pure projection of existing provider facts; unknown source age is never invented. */
export function computeReportRows(
  reports: readonly ComputeCostReport[],
  at: string
): MoneyPlaneRow[] {
  return reports.flatMap((report) => {
    const rows: MoneyPlaneRow[] = [];
    const transfers = new Map(
      report.transferred.map((amount) => [amount.denom, amount.amount])
    );
    const base = {
      label: "Akash hosting",
      kind: "usage" as const,
      balance: null,
      currency: null,
      burnPerDay: null,
      runwayDays: null,
      grade: "UNKNOWN" as const,
      observedAt: at,
      source: "Compute cost ledger",
      sourceObservedAt: null,
      freshness: "unknown" as const,
      payer: "Operator DAO",
      beneficiary: report.nodeId,
      coverage: "operator-covered" as const,
    };
    for (const rate of report.activeRates) {
      const transferred = transfers.get(rate.denom);
      const per = rate.unit;
      rows.push({
        ...base,
        plane: `akash-contract:${report.nodeId}:${rate.denom}:${per}`,
        ...(per === "day" || per === "month" || per === "block"
          ? { nativeRate: { amount: rate.amount, currency: rate.denom, per } }
          : {}),
        detail:
          per === "day" || per === "month" || per === "block"
            ? "Source observation time unavailable"
            : `Native rate: ${rate.amount} ${rate.denom} / ${per}`,
        ...(transferred === undefined
          ? {}
          : {
              cumulativeVendorTransfer: {
                amount: transferred,
                currency: rate.denom,
              },
            }),
      });
      transfers.delete(rate.denom);
    }
    for (const [currency, amount] of transfers) {
      rows.push({
        ...base,
        plane: `akash:${report.nodeId}:${currency}:transfer`,
        cumulativeVendorTransfer: { amount, currency },
        detail: "Cumulative transfer; active rate unavailable",
      });
    }
    if (!rows.length)
      rows.push({
        ...base,
        plane: `akash:${report.nodeId}:unmeasured`,
        detail: "No observed native rate or transfer amount",
      });
    return rows;
  });
}

/** Explicit current sponsorship attribution for existing active aggregates only. */
export function computeRateEvidence(
  reports: readonly ComputeCostReport[]
): CostRateEvidence[] {
  return reports.flatMap((report) =>
    report.activeRates.flatMap((rate) => {
      if (rate.unit !== "day" && rate.unit !== "month" && rate.unit !== "block")
        return [];
      return [
        {
          sourceId: `akash-contract:${report.nodeId}:${rate.denom}:${rate.unit}`,
          ownerId: "operator",
          scopeId: "operator-fleet",
          instrumentId: `akash:${rate.denom}`,
          basis: { kind: "contract" as const, active: true },
          rate: { amount: rate.amount, currency: rate.denom, per: rate.unit },
          sourceObservedAt: null,
          // Current stored projection does not establish complete fleet coverage.
          partial: true,
        },
      ];
    })
  );
}

/** Existing DB statement timeout still bounds the query after this request budget expires. */
export async function computeCostReaders(
  read: (() => Promise<readonly ComputeCostReport[]>) | undefined,
  timeoutMs = 5000
): Promise<{ readers: PlaneReader[]; costRateEvidence: CostRateEvidence[] }> {
  const unknown = () => ({
    readers: [
      unavailableFinanceReader(
        "akash:unavailable",
        "Akash hosting",
        "usage",
        "Node cost evidence unavailable"
      ),
    ],
    costRateEvidence: [],
  });
  if (!read) return unknown();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reports = await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Cost evidence timeout")),
          timeoutMs
        );
      }),
    ]);
    const rows = computeReportRows(reports, new Date().toISOString());
    return rows.length
      ? {
          readers: rows.map((row) => ({
            plane: row.plane,
            label: row.label,
            kind: row.kind,
            read: async () => row,
          })),
          costRateEvidence: computeRateEvidence(reports),
        }
      : unknown();
  } catch {
    return unknown();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
