// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/components/format`
 * Purpose: Human-scale labels, risk ordering and one-line reasons for the Financials table.
 * Scope: Presentation only. Grading and cadence conversion live in the money-plane package and operator adapters.
 * Invariants: No FX; totals are per currency; tiny positive burn never displays as zero;
 *   an unavailable cell is a muted dash with a human reason, never a raw reason code.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import type { Grade, MoneyPlaneRow } from "@cogni/money-plane";

import type { FinanceRow } from "@/ports/finance-report.port";

/** The node that renders this page; its own payer line is noise. */
export const THIS_NODE_PAYER = "Operator";

/** Rows that carry a measured number sort above rows that could not be read. */
function hasData(row: MoneyPlaneRow): boolean {
  return (
    row.balance !== null || row.burnPerDay !== null || row.runwayDays !== null
  );
}

/** RED, YELLOW first; then measured rows (GREEN, INFO, unmeasured-runway); unread placeholders last. */
export function riskRank(row: MoneyPlaneRow): number {
  const byGrade: Record<Grade, number> = {
    RED: 0,
    YELLOW: 1,
    GREEN: 2,
    INFO: 3,
    UNKNOWN: 4,
  };
  if (row.grade === "RED" || row.grade === "YELLOW") return byGrade[row.grade];
  return hasData(row) ? byGrade[row.grade] : 5;
}

export function byRisk(a: MoneyPlaneRow, b: MoneyPlaneRow): number {
  return riskRank(a) - riskRank(b) || a.label.localeCompare(b.label);
}

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

function money(amount: number, currency: string, digits = 2): string {
  const text = amount.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(digits, 2),
    maximumFractionDigits: digits,
  });
  const symbol = SYMBOL[currency];
  return symbol ? `${symbol}${text}` : `${text} ${currency}`;
}

/** Exact native text, with uact scaled to USD credit for humans: "4.21 USD credit (4,210,000 uact)". */
export function nativeLabel(amount: string, currency: string): string {
  const value = Number(amount);
  if (currency === "uact" && Number.isFinite(value)) {
    return `${(value / 1e6).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} USD credit (${value.toLocaleString("en-US")} uact)`;
  }
  return `${amount} ${currency}`;
}

export function balance(row: MoneyPlaneRow): number | undefined {
  return row.balance !== null && Number.isFinite(row.balance) && row.currency
    ? row.balance
    : undefined;
}

/** "10.77 USDC", "€12.40", "$3.10" or "—". */
export function balanceLabel(row: MoneyPlaneRow): string {
  const value = balance(row);
  return value === undefined || !row.currency
    ? "—"
    : money(value, row.currency);
}

export function burn(row: MoneyPlaneRow): number | undefined {
  return row.burnPerDay !== null &&
    Number.isFinite(row.burnPerDay) &&
    row.burnPerDay >= 0
    ? row.burnPerDay
    : undefined;
}

/** "$0.19/day" or "—"; a positive burn below one cent reads "<$0.01/day". */
export function burnLabel(row: MoneyPlaneRow): string {
  const value = burn(row);
  if (value === undefined) return "—";
  const currency = row.currency ?? "USD";
  if (value > 0 && value < 0.005) return `<${money(0.01, currency)}/day`;
  return `${money(value, currency)}/day`;
}

export function runway(row: MoneyPlaneRow): number | undefined {
  return (row.grade === "RED" ||
    row.grade === "YELLOW" ||
    row.grade === "GREEN") &&
    row.runwayDays !== null &&
    Number.isFinite(row.runwayDays) &&
    row.runwayDays >= 0
    ? row.runwayDays
    : undefined;
}

/** "12d" or "—"; a graded runway under one day reads "<1d". */
export function runwayLabel(row: MoneyPlaneRow): string {
  const days = runway(row);
  if (days === undefined) return "—";
  return days < 1 ? "<1d" : `${Math.floor(days)}d`;
}

export type RunwayTone = "destructive" | "warning" | "success" | "muted";
export function runwayTone(grade: Grade): RunwayTone {
  return grade === "RED"
    ? "destructive"
    : grade === "YELLOW"
      ? "warning"
      : grade === "GREEN"
        ? "success"
        : "muted";
}

/** Burn per day summed per currency across measured, non-rollup rows; never converted between currencies. */
export function fleetBurnByCurrency(
  rows: readonly FinanceRow[]
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const value = burn(row);
    if (value === undefined || row.rollup || !row.currency) continue;
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + value);
  }
  return totals;
}

/** USD per day across every measured USD burn, excluding rollups; undefined when nothing is measured. */
export function fleetBurnPerDay(
  rows: readonly FinanceRow[]
): number | undefined {
  return fleetBurnByCurrency(rows).get("USD");
}

/** "Burn $12.85/day · €0.34/day"; empty when nothing is measured. USD first, never converted. */
export function fleetBurnLabel(rows: readonly FinanceRow[]): string {
  const totals = fleetBurnByCurrency(rows);
  const parts = [...totals]
    .sort(([a], [b]) =>
      a === "USD" ? -1 : b === "USD" ? 1 : a.localeCompare(b)
    )
    .map(([currency, value]) => `${money(value, currency)}/day`);
  return parts.length ? `Burn ${parts.join(" · ")}` : "";
}

/** The payer, only when it is not this node; the beneficiary is dialog detail. */
export function payerLabel(row: MoneyPlaneRow): string {
  return row.payer && row.payer !== THIS_NODE_PAYER
    ? `Paid by ${row.payer}`
    : "";
}

/** "Operator · for beacon" for the dialog; empty when nothing is known. */
export function whoPaysLabel(row: MoneyPlaneRow): string {
  return [row.payer ?? "", row.beneficiary ? `for ${row.beneficiary}` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** One human line explaining why a cell is unavailable; undefined when the row is fully measured. */
export function unavailableReason(row: MoneyPlaneRow): string | undefined {
  switch (row.reasonCode) {
    case "unconfigured":
      return (
        row.detail ??
        (row.kind === "wallet" ? "no address configured" : "no key configured")
      );
    case "unreadable":
      return row.kind === "wallet" ? "RPC unavailable" : "provider unreadable";
    case "timeout":
      return "provider did not answer in time";
    case "stale":
      return "source data is stale";
    case "burn_unmeasured":
      return "burn not measured";
    case "lease_starved":
      return "lease escrow exhausted";
    case "no_leases":
      return "no active lease";
    case "escrow_advisory":
      return "escrow running low";
    default:
      return row.grade === "UNKNOWN" ? "not measured" : undefined;
  }
}

/** Basis and cadence of the row's numbers, ≤ 4 words, for the Source dialog. */
export function basisLabel(row: MoneyPlaneRow): string | undefined {
  const divided = runway(row) !== undefined && burn(row) !== undefined;
  if (row.nativeRate)
    return `contract rate / ${row.nativeRate.per}${divided ? " · balance ÷ burn" : ""}`;
  if (divided) return "balance ÷ burn";
  if (row.kind === "expiry" && runway(row) !== undefined)
    return "days to expiry";
  if (burn(row) !== undefined) return "measured / day";
  if (balance(row) !== undefined) return "balance read";
  return undefined;
}

/** "Oct 26, 2026, 1:40 PM EDT" in the given zone, or undefined for an unparseable time. */
export function observedLabel(
  value: string | null | undefined,
  timeZone?: string
): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

/** "6:40 AM" when the report is from today in the viewer's zone, else "Oct 25, 6:40 AM". */
export function refreshedLabel(
  value: string,
  timeZone?: string,
  now: Date = new Date()
): string {
  if (!Number.isFinite(Date.parse(value))) return "—";
  const zone = timeZone ? { timeZone } : {};
  const day = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { ...zone, dateStyle: "short" }).format(d);
  const at = new Date(value);
  const time = new Intl.DateTimeFormat("en-US", {
    ...zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  if (day(at) === day(now)) return time;
  const date = new Intl.DateTimeFormat("en-US", {
    ...zone,
    month: "short",
    day: "numeric",
  }).format(at);
  return `${date}, ${time}`;
}
