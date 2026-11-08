// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/lib/display`
 * Purpose: Everything a KPI card or chart shows, by display type. progress = a
 *   value against a target; volume = an amount and its change; slo = a
 *   percentage against a ≥/≤ objective with an error budget. The type comes
 *   from the read model (calculator default or the author's override).
 * Scope: Pure. Reads contract values only; never re-derives status.
 * Invariants: UNKNOWN_IS_NOT_ZERO (no value → null, never 0); GAPS_STAY_GAPS
 *   (non-ok buckets are null points); one formatter per display, so a value
 *   reads the same on the card, in the tooltip and in the readings list.
 * Side-effects: none
 * Links: packages/metrics/src/contracts.ts (MetricDisplaySchema, GoalKpiSchema)
 * @public
 */

import type {
  KpiBinding,
  MetricDisplay,
  MetricHistory,
} from "@cogni-dao/metrics/contracts";

import {
  COMPARATOR_SYMBOL,
  formatDate,
  formatNumber,
  formatUtcTime,
  type GoalKpi,
} from "./presentation";

export type { MetricDisplay };

/** Daily buckets with a reading before the card prefers the daily trend. */
export const MIN_DAILY_SHAPE = 3;

export function displayOf(kpi: GoalKpi): MetricDisplay {
  return kpi.metric?.display ?? "progress";
}

/** 99.9996 reads 99.999, never a rounded-up 100. */
export function formatPercent(value: number): string {
  const digits = value >= 99.99 ? 3 : value >= 99 ? 2 : 1;
  const f = 10 ** digits;
  return (Math.trunc(value * f) / f).toFixed(digits).replace(/\.?0+$/, "");
}

/** One reading as every surface prints it. */
export function formatValue(
  value: number,
  display: MetricDisplay,
  unit: string
): string {
  if (display === "slo") return `${formatPercent(value)}%`;
  if (Math.abs(value) >= 10_000)
    return new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  return formatNumber(value, unit);
}

export function meetsTarget(
  value: number,
  binding: Pick<KpiBinding, "comparator" | "target">
): boolean {
  const t = binding.target.value;
  return binding.comparator === "gte"
    ? value >= t
    : binding.comparator === "lte"
      ? value <= t
      : value === t;
}

/** Share of the error budget left, −1..1; null when the objective has no budget. */
export function sloBudget(
  value: number,
  binding: Pick<KpiBinding, "comparator" | "target">
): number | null {
  const t = binding.target.value;
  const room =
    binding.comparator === "gte"
      ? 100 - t
      : binding.comparator === "lte"
        ? t
        : 0;
  if (room <= 0) return null;
  const left = binding.comparator === "gte" ? value - t : t - value;
  return Math.max(-1, Math.min(1, left / room));
}

export interface Point {
  readonly t: number;
  readonly v: number | null;
  readonly observationId: string | null;
}

/** Buckets as points (gaps null), plus the newest reading when it is past the last bucket. */
export function seriesPoints(series: MetricHistory, kpi?: GoalKpi): Point[] {
  const points: Point[] = series.buckets.map((b) => ({
    t: Date.parse(b.start),
    v: b.status === "ok" ? b.value : null,
    observationId: b.status === "ok" ? b.observationId : null,
  }));
  const a = kpi?.assessment;
  if (
    a?.value != null &&
    a.observedAt &&
    Date.parse(a.observedAt) >= Date.parse(series.to)
  )
    points.push({
      t: Date.parse(a.observedAt),
      v: a.value,
      observationId: a.observationId,
    });
  return points;
}

function readingCount(series: MetricHistory | null | undefined): number {
  return series?.buckets.filter((b) => b.status === "ok").length ?? 0;
}

/** The daily trend once it has a shape; before that, the last day hourly. */
export function cardSeries(kpi: GoalKpi): MetricHistory | null {
  if (readingCount(kpi.trend) >= MIN_DAILY_SHAPE || !kpi.recent)
    return kpi.trend;
  return kpi.recent;
}

/**
 * A card mark starts at its first reading: the time before a series began is
 * not a gap, and a glance should not spend its width on it. Later gaps stay.
 */
export function fromFirstReading(points: readonly Point[]): Point[] {
  const first = points.findIndex((p) => p.v !== null);
  return first < 0 ? [] : points.slice(first);
}

/** Change from the first reading in `series` to now, labelled by the bucket it was read in. */
function changeHint(
  kpi: GoalKpi,
  display: MetricDisplay,
  series: MetricHistory | null
): string | null {
  const { value } = kpi.assessment;
  const first = series?.buckets.find(
    (b) => b.status === "ok" && b.value !== null
  );
  if (
    value === null ||
    !series ||
    !first ||
    first.value === null ||
    readingCount(series) < 2
  )
    return null;
  // No change says nothing at a glance; the target does.
  if (value === first.value) return null;
  // An hour reads as a time only on the same UTC day as the value; otherwise as its date.
  const sameDay =
    first.start.slice(0, 10) === (kpi.assessment.observedAt ?? "").slice(0, 10);
  const since =
    series.step === "1h" && sameDay
      ? formatUtcTime(first.start).replace(" UTC", "")
      : formatDate(first.start);
  return `${signed(value - first.value, display, kpi.binding.target.unit)} since ${since}`;
}

function signed(delta: number, display: MetricDisplay, unit: string): string {
  return `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${formatValue(Math.abs(delta), display, unit)}`;
}

/** The one muted hint under the number, ≤ 3 words. */
export function cardHint(
  kpi: GoalKpi,
  display: MetricDisplay,
  series: MetricHistory | null
): string {
  const { value } = kpi.assessment;
  const target = `${COMPARATOR_SYMBOL[kpi.binding.comparator]} ${formatValue(kpi.binding.target.value, display, kpi.binding.target.unit)}`;
  if (display === "slo") {
    const budget = value === null ? null : sloBudget(value, kpi.binding);
    return budget === null ? target : `budget ${Math.round(budget * 100)}%`;
  }
  if (display === "volume") return changeHint(kpi, display, series) ?? target;
  return target;
}

/** Progress bar fill 0..1 toward the target; null without a value. */
export function progressFraction(kpi: GoalKpi): number | null {
  const { value } = kpi.assessment;
  const t = kpi.binding.target.value;
  if (value === null) return null;
  if (meetsTarget(value, kpi.binding)) return 1;
  if (kpi.binding.comparator === "lte")
    return value > 0 ? Math.max(0, t / value) : 0;
  return t > 0 ? Math.max(0, Math.min(1, value / t)) : 0;
}

/** Lowest bar still shows: the floor sits below the worst reading and the objective. */
function sloFloor(values: readonly number[], target: number): number {
  const worst = Math.min(target, ...values);
  return Math.max(0, worst - Math.max(100 - worst, 0.05) * 0.5);
}

/** Y domain by type: progress from 0 (or below), volume padded around the data, slo up to 100. */
export function yDomain(
  display: MetricDisplay,
  values: readonly number[],
  target: number | null,
  comparator: KpiBinding["comparator"] = "gte"
): [number, number] {
  const all = target === null ? [...values] : [...values, target];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  if (display === "slo")
    // A ≥ objective lives near 100; a ≤ objective (an error rate) near 0.
    return comparator === "lte"
      ? [0, Math.max(hi * 1.5, 0.01)]
      : [sloFloor(values, target ?? lo), 100];
  if (display === "progress")
    return [Math.min(0, lo), hi > 0 ? hi * 1.15 : hi + 1];
  const pad = Math.max(hi - lo, Math.abs(hi) * 0.1, 1) * 0.3;
  return [lo - pad, hi + pad];
}

/**
 * A volume target joins the chart while it is still ahead of the latest
 * reading; once met, only when it sits within one data span of the readings.
 */
export function targetInView(
  display: MetricDisplay,
  values: readonly number[],
  binding: Pick<KpiBinding, "comparator" | "target">
): boolean {
  if (display !== "volume") return true;
  const latest = values.at(-1);
  if (latest === undefined) return false;
  if (!meetsTarget(latest, binding)) return true;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.max(hi - lo, Math.abs(hi) * 0.25, 1);
  const t = binding.target.value;
  return t >= lo - span && t <= hi + span;
}
