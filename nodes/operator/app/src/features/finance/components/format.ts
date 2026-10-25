// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/finance/components/format`
 * Purpose: Human-scale labels and native-unit sorting for the Financials grid.
 * Scope: Presentation only. Aggregate arithmetic lives in the shared money-plane package.
 * Invariants: No FX conversion; tiny positive values never display as zero.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import type {
  MoneyPlaneRow,
  NativeAmount,
  NativeRate,
} from "@cogni/money-plane";

export type SortAmount = NativeAmount & {
  per?: NativeRate["per"];
  instrument?: string;
};
export function rowAmount(
  amount: number | null,
  currency: string | null
): SortAmount | undefined {
  return amount !== null && Number.isFinite(amount) && currency
    ? { amount: String(amount), currency }
    : undefined;
}
export function nativeBurn(row: MoneyPlaneRow): SortAmount | undefined {
  if (row.nativeRate) return row.nativeRate;
  const value = rowAmount(row.burnPerDay, row.currency);
  return value ? { ...value, per: "day" } : undefined;
}
export function amountLabel(value: SortAmount | undefined): string {
  if (!value) return "—";
  const units: Record<string, string> = {
    uact: value.per ? "USD credit" : "USD compute credit",
    uusdc: "USDC",
    uakt: "AKT",
  };
  const number = Number(value.amount) / (value.currency in units ? 1e6 : 1);
  if (!Number.isFinite(number)) return "—";
  const display =
    number !== 0 && Math.abs(number) < 0.000001
      ? `${number < 0 ? "−" : ""}<0.000001`
      : number.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return `${display} ${units[value.currency] ?? value.currency}${value.per ? ` / ${value.per}` : ""}`;
}
export function compareAmounts(
  a: SortAmount | undefined,
  b: SortAmount | undefined
): number {
  if (!a || !b) return 0; // TanStack sortUndefined keeps missing cells last in both directions.
  const unit =
    `${a.instrument ?? ""}/${a.currency}/${a.per ?? ""}`.localeCompare(
      `${b.instrument ?? ""}/${b.currency}/${b.per ?? ""}`
    );
  return unit || Number(a.amount) - Number(b.amount);
}
export function observedLabel(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unknown";
  return `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
