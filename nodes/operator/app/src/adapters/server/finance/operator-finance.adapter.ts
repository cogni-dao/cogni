// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/finance/operator-finance.adapter`
 * Purpose: Project existing compute balance and cost evidence into shared finance readers.
 * Scope: Read-only projection; no new storage, currency conversion or payment history inference.
 * Invariants: Every native rate/transfer group retained; transfers attached once per denomination.
 * Side-effects: IO through injected compute ports only.
 * Links: https://cognidao.org/work/items/task.5347
 * @public
 */
import type { ComputeResourcePort } from "@cogni/ai-tools";
import {
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

export function computeBalanceReader(
  compute: ComputeResourcePort
): PlaneReader {
  const plane = "cherry:account";
  return {
    plane,
    label: "Cherry compute",
    kind: "prepaid",
    async read() {
      const at = new Date().toISOString();
      try {
        const balances = await compute.balances();
        // This composition currently binds exactly one provider account. Multiple
        // accounts cannot safely be collapsed into a single balance.
        const balance = balances.length === 1 ? balances[0] : undefined;
        if (!balance || !Number.isFinite(balance.remaining)) {
          return {
            ...unknownRow({
              plane,
              label: "Cherry compute",
              kind: "prepaid",
              reasonCode: "unconfigured",
              observedAt: at,
              detail:
                balances.length > 1
                  ? "Multiple accounts need separate reporting"
                  : "No compute balance available",
            }),
            source: "Compute balance port",
            sourceObservedAt: null,
            freshness: "unknown",
            payer: "Operator DAO",
            beneficiary: "Fleet",
            coverage: "operator-covered",
          };
        }
        return {
          plane,
          label: "Cherry compute",
          kind: "prepaid",
          balance: balance.remaining,
          currency: balance.currency,
          burnPerDay: null,
          runwayDays: balance.remaining <= 0 ? 0 : null,
          grade: balance.remaining <= 0 ? "RED" : "UNKNOWN",
          observedAt: at,
          source: "Compute balance port",
          sourceObservedAt: balance.asOf,
          freshness: "current",
          payer: "Operator DAO",
          beneficiary: "Fleet",
          coverage: "operator-covered",
          reasonCode: "burn_unmeasured",
        };
      } catch {
        return {
          ...unknownRow({
            plane,
            label: "Cherry compute",
            kind: "prepaid",
            reasonCode: "unreadable",
            observedAt: at,
            detail: "Compute balance read failed",
          }),
          source: "Compute balance port",
          sourceObservedAt: null,
          freshness: "unknown",
        };
      }
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
        plane: `akash:${report.nodeId}:${rate.denom}:${per}`,
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

/** Existing DB statement timeout still bounds the query after this request budget expires. */
export async function computeCostReaders(
  read: (() => Promise<readonly ComputeCostReport[]>) | undefined,
  timeoutMs = 5000
): Promise<PlaneReader[]> {
  const unknown = () => [
    unavailableFinanceReader(
      "akash:unavailable",
      "Akash hosting",
      "usage",
      "Node cost evidence unavailable"
    ),
  ];
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
      ? rows.map((row) => ({
          plane: row.plane,
          label: row.label,
          kind: row.kind,
          read: async () => row,
        }))
      : unknown();
  } catch {
    return unknown();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
