// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/lib/presentation`
 * Purpose: Pure presentation for the Goals tab: status words and symbols, plain
 *   reason text, number/date formatting, summary counts, aligned history
 *   windows (hourly 1D/1W, daily 1M/3M) and the hero label.
 * Scope: Pure functions over `@cogni-dao/metrics/contracts` shapes. Never
 *   decides status (assessKpi does); never fills, bridges or invents readings.
 * Invariants: STATUS_HAS_WORD_AND_SYMBOL (color is never the only signal);
 *   EVERY_REASON_HAS_PLAIN_TEXT (exhaustive over KpiReason); GAPS_STAY_GAPS.
 * Side-effects: none
 * Links: packages/metrics/src/contracts.ts, .context/design-0024/goals-visual.html
 * @public
 */

import type {
  GoalProgress,
  KpiAssessment,
  KpiReason,
  KpiStatus,
  MetricHistoryStep,
} from "@cogni-dao/metrics/contracts";

export type GoalKpi = GoalProgress["kpis"][number];
export type StatusTone = "success" | "warning" | "danger" | "neutral";

/** One word and one symbol per status. Color is a third, redundant signal. */
export const STATUS_META = {
  on_track: {
    symbol: "●",
    label: "On track",
    short: "On track",
    tone: "success",
  },
  behind: {
    symbol: "▼",
    label: "Behind pace",
    short: "Behind",
    tone: "warning",
  },
  met: { symbol: "✓", label: "Met", short: "Met", tone: "success" },
  missed: { symbol: "✕", label: "Missed", short: "Missed", tone: "danger" },
  delayed: { symbol: "◷", label: "Delayed", short: "Delayed", tone: "warning" },
  failing: { symbol: "!", label: "Failing", short: "Failing", tone: "danger" },
  building: {
    symbol: "…",
    label: "Building",
    short: "Building",
    tone: "neutral",
  },
  not_measured: {
    symbol: "○",
    label: "Not measured",
    short: "Not measured",
    tone: "neutral",
  },
  evaluating: {
    symbol: "◌",
    label: "Evaluating",
    short: "Evaluating",
    tone: "neutral",
  },
  unresolved: {
    symbol: "?",
    label: "Unresolved",
    short: "Unresolved",
    tone: "neutral",
  },
} as const satisfies Record<
  KpiStatus,
  { symbol: string; label: string; short: string; tone: StatusTone }
>;

/** Every machine reason in one sentence a person can act on. */
export const REASON_TEXT = {
  no_binding: "No metric is bound to this goal yet.",
  calculator_unavailable: "Its calculator is not installed on this node.",
  metric_unavailable: "Its metric definition is missing or unreadable.",
  metric_authority_unavailable: "The metric store cannot be reached right now.",
  insufficient_history: "Not enough history yet to cover the KPI window.",
  zero_denominator: "Nothing to divide by yet: the denominator is zero.",
  history_unavailable: "The source history could not be read.",
  source_failed: "The data source returned an error.",
  source_timeout: "The data source timed out.",
  incomplete_or_invalid_source:
    "The source returned incomplete or invalid data.",
  unit_mismatch: "The reading's unit does not match the target's unit.",
  no_reading_at_evaluation: "No reading existed at the deadline.",
  evaluation_not_due: "The evaluation date has not arrived yet.",
  baseline_unavailable_or_incompatible:
    "The baseline reading is missing or incompatible.",
  fixed_prediction_and_baseline_required:
    "This bet needs a fixed prediction and baseline.",
} as const satisfies Record<KpiReason, string>;

export function reasonText(reason: KpiReason | null): string | null {
  return reason ? REASON_TEXT[reason] : null;
}

/** Statuses that make a goal need attention (tab badge, summary). */
const ATTENTION_STATUSES: ReadonlySet<KpiStatus> = new Set([
  "behind",
  "failing",
  "missed",
]);

export function goalNeedsAttention(goal: GoalProgress): boolean {
  return goal.kpis.some((k) => ATTENTION_STATUSES.has(k.assessment.status));
}

export function attentionCount(goals: readonly GoalProgress[]): number {
  return goals.filter(goalNeedsAttention).length;
}

export function isMeasured(goal: GoalProgress): boolean {
  return goal.kpis.some((k) => k.assessment.status !== "not_measured");
}

// ---------------------------------------------------------------- formatting

export const COMPARATOR_SYMBOL = { gte: "≥", lte: "≤", eq: "=" } as const;

/** Units read with fixed precision so a value, its target and its axis align. */
const FIXED_DECIMALS: Record<string, number> = { ratio: 2 };

/** Integers stay integers; fractions get two places; a ratio always reads 0.80 and 1.00. */
export function formatNumber(value: number, unit?: string): string {
  const fixed = unit ? FIXED_DECIMALS[unit] : undefined;
  if (value === 0) return "0";
  if (fixed !== undefined)
    return new Intl.NumberFormat("en", {
      minimumFractionDigits: fixed,
      maximumFractionDigits: fixed,
    }).format(value);
  if (Number.isInteger(value)) return new Intl.NumberFormat("en").format(value);
  const abs = Math.abs(value);
  return new Intl.NumberFormat("en", {
    minimumFractionDigits: abs < 100 ? 2 : 0,
    maximumFractionDigits: abs < 100 ? 2 : 1,
  }).format(value);
}

const DAY_MS = 86_400_000;

export function formatDate(iso: string, withYear = false): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(new Date(iso));
}

export function formatUtcTime(iso: string): string {
  return `${new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(iso))} UTC`;
}

/** "10:00 UTC" today; "Oct 30, 10:00 UTC" otherwise. */
function formatReadingTime(iso: string, nowIso: string): string {
  const sameDay =
    new Date(iso).toISOString().slice(0, 10) ===
    new Date(nowIso).toISOString().slice(0, 10);
  return sameDay
    ? formatUtcTime(iso)
    : `${formatDate(iso)}, ${formatUtcTime(iso)}`;
}

// ---------------------------------------------------------------- summary

/** Counts across the board: goals, their KPIs, and KPIs per status. */
export interface GoalsSummary {
  readonly goals: number;
  readonly kpis: number;
  readonly byStatus: Readonly<Partial<Record<KpiStatus, number>>>;
}

export function summarize(goals: readonly GoalProgress[]): GoalsSummary {
  const byStatus: Partial<Record<KpiStatus, number>> = {};
  let kpis = 0;
  for (const g of goals)
    for (const k of g.kpis) {
      kpis++;
      byStatus[k.assessment.status] = (byStatus[k.assessment.status] ?? 0) + 1;
    }
  return { goals: goals.length, kpis, byStatus };
}

/** Most urgent first: the status a collapsed goal row shows. */
const STATUS_RANK: readonly KpiStatus[] = [
  "missed",
  "failing",
  "behind",
  "delayed",
  "unresolved",
  "evaluating",
  "building",
  "not_measured",
  "on_track",
  "met",
];

export function worstStatus(goal: GoalProgress): KpiStatus | null {
  const present = new Set(goal.kpis.map((k) => k.assessment.status));
  return STATUS_RANK.find((s) => present.has(s)) ?? null;
}

// ---------------------------------------------------------------- history range

export type HistoryRange = "1d" | "1w" | "1m" | "3m";

interface FixedRange {
  readonly id: HistoryRange;
  readonly label: string;
  readonly step: MetricHistoryStep;
  readonly count: number;
}

export const HISTORY_RANGES: readonly FixedRange[] = [
  { id: "1d", label: "1D", step: "1h", count: 24 },
  { id: "1w", label: "1W", step: "1h", count: 168 },
  { id: "1m", label: "1M", step: "1d", count: 30 },
  { id: "3m", label: "3M", step: "1d", count: 90 },
];

export const STEP_MS: Record<MetricHistoryStep, number> = {
  "1h": 3_600_000,
  "1d": DAY_MS,
  "1w": 7 * DAY_MS,
};
/** Weekly buckets align to Monday 2000-01-03T00:00Z (the server's origin). */
const WEEK_ORIGIN = Date.UTC(2000, 0, 3);
function floorToStep(ms: number, step: MetricHistoryStep): number {
  const size = STEP_MS[step];
  const origin = step === "1w" ? WEEK_ORIGIN : 0;
  return origin + Math.floor((ms - origin) / size) * size;
}

export interface HistoryWindow {
  readonly from: string;
  readonly to: string;
  readonly step: MetricHistoryStep;
}

function windowOf(
  fromMs: number,
  toMs: number,
  step: MetricHistoryStep
): HistoryWindow {
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    step,
  };
}

/** `to` is the last closed step boundary (the server rejects to > now). */
export function historyWindow(
  range: HistoryRange,
  nowMs: number
): HistoryWindow {
  const r = HISTORY_RANGES.find((x) => x.id === range) as FixedRange;
  const to = floorToStep(nowMs, r.step);
  return windowOf(to - r.count * STEP_MS[r.step], to, r.step);
}

/** The evidence route for one observation, pinned by id. */
export function observationHref(
  metricId: string,
  observationId: string
): string {
  return `/knowledge/${encodeURIComponent(metricId)}?observation=${encodeURIComponent(observationId)}`;
}

// ---------------------------------------------------------------- header

/**
 * The hero speaks for the assessment, never for the chart range. Its label
 * says which reading it is: final, at the deadline, latest or last good.
 */
export function heroLabel(
  a: Pick<KpiAssessment, "status" | "value" | "observedAt">,
  nowIso: string
): string | null {
  if (a.value === null || !a.observedAt) return null;
  const time = formatReadingTime(a.observedAt, nowIso);
  switch (a.status) {
    case "met":
    case "missed":
      return `Final · ${time}`;
    case "evaluating":
      return `At deadline · ${time}`;
    case "on_track":
    case "behind":
      return `Latest · ${time}`;
    default:
      return `Last good · ${time}`;
  }
}
