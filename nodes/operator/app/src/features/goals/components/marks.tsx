// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/components/marks`
 * Purpose: The pieces both the KPI card and the open chart draw with: status
 *   pill, progress bar, volume sparkline, SLO availability strip, the shared
 *   area gradient and the SSR-stable chart id.
 * Scope: Stateless. Inputs are already-assessed contract values.
 * Invariants: Status = symbol + word (+ colour). Every mark sits in a
 *   div role="img" whose aria-label states the values. Gaps are never bridged;
 *   no reading draws nothing (never a zero line). Recharts 2 renders only its
 *   own element types as chart children, so shared pieces are functions that
 *   return elements, never components. No animation.
 * Side-effects: none
 * Links: ../lib/display.ts, ../lib/presentation.ts
 * @public
 */

"use client";

import { ChartContainer } from "@cogni/node-ui-kit/shadcn/chart";
import type {
  KpiBinding,
  KpiStatus,
  MetricHistory,
} from "@cogni-dao/metrics/contracts";
import { useId } from "react";
import { Area, AreaChart, Bar, BarChart, Cell, YAxis } from "recharts";

import {
  fromFirstReading,
  meetsTarget,
  type Point,
  seriesPoints,
  yDomain,
} from "../lib/display";
import { STATUS_META, type StatusTone } from "../lib/presentation";

const TONE_CLASS: Record<StatusTone, string> = {
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/15 text-warning",
  // The dark --destructive token is a fill colour; text needs the lighter red to read on black.
  danger:
    "border-destructive/50 bg-destructive/15 text-destructive dark:text-red-400",
  neutral: "border-border bg-muted/60 text-muted-foreground",
};

/** Series colour; status colours stay on the pill. */
const SERIES_COLOR = "hsl(var(--chart-1))";
/** Below-objective bar. */
const MISS_COLOR = "var(--color-destructive)";

export function StatusPill({ status }: { readonly status: KpiStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      data-status={status}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-medium text-xs leading-4 ${TONE_CLASS[meta.tone]}`}
    >
      <span aria-hidden="true">{meta.symbol}</span>
      {meta.short}
    </span>
  );
}

/** Stable, selector-safe chart id (React 19 ids contain « » or colons). */
export function useChartId(prefix: string): string {
  return `${prefix}-${useId().replace(/[^\w-]/g, "")}`;
}

/** Vertical fade under an area series; a function so Recharts keeps it. */
export function areaGradient(id: string, top = 0.28) {
  return (
    <defs key="defs">
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="var(--color-v)" stopOpacity={top} />
        <stop offset="100%" stopColor="var(--color-v)" stopOpacity={0.03} />
      </linearGradient>
    </defs>
  );
}

/** One bar colour per point: series colour when the objective holds, miss colour when it does not. */
export function barCells(
  points: readonly Point[],
  binding: Pick<KpiBinding, "comparator" | "target">
) {
  return points.map((p) => (
    <Cell
      key={p.t}
      fill={
        p.v !== null && !meetsTarget(p.v, binding)
          ? MISS_COLOR
          : "var(--color-v)"
      }
    />
  ));
}

export const CHART_CONFIG = { v: { label: "value", color: SERIES_COLOR } };

/** Fill toward the target. */
export function ProgressBar({
  fraction,
  label,
}: {
  readonly fraction: number | null;
  readonly label: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      {fraction !== null && (
        <div
          className="h-full rounded-full bg-chart-1"
          style={{ width: `${Math.max(2, fraction * 100)}%` }}
        />
      )}
    </div>
  );
}

/** Volume: gradient area over the series; gaps break the line. */
export function Sparkline({
  series,
  label,
}: {
  readonly series: MetricHistory | null;
  readonly label: string;
}) {
  const id = useChartId("spark");
  const data = series ? fromFirstReading(seriesPoints(series)) : [];
  const values = data.flatMap((d) => (d.v === null ? [] : [d.v]));
  return (
    <div role="img" aria-label={label} className="h-10 w-full">
      {values.length >= 2 && (
        <ChartContainer
          config={CHART_CONFIG}
          className="aspect-auto h-10 w-full"
        >
          <AreaChart
            id={id}
            data={data}
            margin={{ top: 2, right: 0, bottom: 0, left: 0 }}
          >
            {areaGradient(`${id}-fill`, 0.3)}
            <YAxis hide domain={yDomain("volume", values, null)} />
            <Area
              id={`${id}-area`}
              dataKey="v"
              type="monotone"
              stroke="var(--color-v)"
              strokeWidth={2}
              fill={`url(#${id}-fill)`}
              connectNulls={false}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </div>
  );
}

/** SLO: one bar per bucket, miss colour where the objective fails, empty where there is no reading. */
export function AvailabilityStrip({
  series,
  binding,
  label,
}: {
  readonly series: MetricHistory | null;
  readonly binding: Pick<KpiBinding, "comparator" | "target">;
  readonly label: string;
}) {
  const id = useChartId("slo");
  const data = series ? seriesPoints(series) : [];
  const values = data.flatMap((d) => (d.v === null ? [] : [d.v]));
  return (
    <div role="img" aria-label={label} className="h-10 w-full">
      {values.length > 0 && (
        <ChartContainer
          config={CHART_CONFIG}
          className="aspect-auto h-10 w-full"
        >
          <BarChart
            id={id}
            data={data}
            margin={{ top: 2, right: 0, bottom: 0, left: 0 }}
            barCategoryGap={1}
          >
            <YAxis
              hide
              domain={yDomain(
                "slo",
                values,
                binding.target.value,
                binding.comparator
              )}
              allowDataOverflow
            />
            <Bar
              id={`${id}-bar`}
              dataKey="v"
              isAnimationActive={false}
              radius={1}
            >
              {barCells(data, binding)}
            </Bar>
          </BarChart>
        </ChartContainer>
      )}
    </div>
  );
}
