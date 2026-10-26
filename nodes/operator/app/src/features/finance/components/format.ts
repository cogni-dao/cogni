// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/components/format`
 * Purpose: Human-scale labels, risk ordering and one-line reasons for the Financials table.
 * Scope: Presentation only. Grading and cadence conversion live in the money-plane package and operator adapter.
 * Invariants: No FX; a fleet total sums only USD-denominated burn; tiny positive burn never displays as zero;
 *   an unavailable cell is a muted dash with a human reason, never a raw reason code.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import type { Grade, MoneyPlaneRow } from "@cogni/money-plane";

/** RED first; UNKNOWN before GREEN because unread is not fine; INFO (holdings) last. */
export const RISK_RANK: Record<Grade, number> = {
  RED: 0,
  YELLOW: 1,
  UNKNOWN: 2,
  GREEN: 3,
  INFO: 4,
};

export function byRisk(a: MoneyPlaneRow, b: MoneyPlaneRow): number {
  return (
    RISK_RANK[a.grade] - RISK_RANK[b.grade] || a.label.localeCompare(b.label)
  );
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

/** "$0.19 / day" or "—"; a positive burn below one cent reads "<$0.01 / day". */
export function burnLabel(row: MoneyPlaneRow): string {
  const value = burn(row);
  if (value === undefined) return "—";
  const currency = row.currency ?? "USD";
  if (value > 0 && value < 0.005) return `<${money(0.01, currency)} / day`;
  return `${money(value, currency)} / day`;
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

/** "12 d" or "—"; a graded runway under one day reads "<1 d". */
export function runwayLabel(row: MoneyPlaneRow): string {
  const days = runway(row);
  if (days === undefined) return "—";
  return days < 1 ? "<1 d" : `${Math.floor(days)} d`;
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

/** USD per day across every row with a measured USD burn; undefined when nothing is measured. */
export function fleetBurnPerDay(
  rows: readonly MoneyPlaneRow[]
): number | undefined {
  const usd = rows.filter((row) => row.currency === "USD" && burn(row));
  if (usd.length === 0) return undefined;
  return usd.reduce((sum, row) => sum + (burn(row) ?? 0), 0);
}

export function usdLabel(amount: number): string {
  return money(amount, "USD");
}

/** Readable "Paid by … · for …" when the row names a payer or beneficiary; empty otherwise. */
export function attributionLabel(row: MoneyPlaneRow): string {
  return [
    row.payer ? `Paid by ${row.payer}` : "",
    row.beneficiary ? `for ${row.beneficiary}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One human line explaining why a cell is unavailable; undefined when the row is fully measured. */
export function unavailableReason(row: MoneyPlaneRow): string | undefined {
  switch (row.reasonCode) {
    case "unconfigured":
      return row.kind === "wallet"
        ? "no address configured"
        : "no key configured";
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

/** Basis and cadence of the row's numbers, for the Source dialog. */
export function basisLabel(row: MoneyPlaneRow): string | undefined {
  if (row.nativeRate) return `Contract rate · per ${row.nativeRate.per}`;
  if (burn(row) !== undefined) return "Measured burn · per day";
  if (balance(row) !== undefined) return "Measured balance";
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
