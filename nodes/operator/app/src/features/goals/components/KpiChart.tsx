// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/components/KpiChart`
 * Purpose: The open KPI: one big number, a range toggle and one chart drawn by
 *   display type (progress/volume = gradient area; slo = availability bars),
 *   with a single target line. Nothing else.
 * Scope: Client component. Reads GET /api/v1/metrics/{id}/history; never computes.
 * Invariants: GAPS_STAY_GAPS (missing buckets are null, connectNulls=false);
 *   the newest reading after the last closed bucket is its own point; the
 *   number speaks for the assessment, never for the range; the previous range
 *   stays on screen while the next one loads; the chart surface is named by the
 *   visible metric title; a collapsed readings list is the keyboard path to
 *   each observation.
 * Side-effects: IO (via fetchMetricHistory)
 * Links: ../lib/display.ts, packages/metrics/src/contracts.ts (MetricHistorySchema)
 * @public
 */

"use client";

import { ChartContainer, ChartTooltip } from "@cogni/node-ui-kit/shadcn/chart";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@cogni/node-ui-kit/shadcn/toggle-group";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import { fetchMetricHistory } from "../lib/api";
import {
  displayOf,
  formatValue,
  MIN_DAILY_SHAPE,
  type Point,
  seriesPoints,
  targetInView,
  yDomain,
} from "../lib/display";
import {
  COMPARATOR_SYMBOL,
  formatDate,
  formatUtcTime,
  type GoalKpi,
  HISTORY_RANGES,
  type HistoryRange,
  heroLabel,
  historyWindow,
  observationHref,
  STEP_MS,
} from "../lib/presentation";
import { areaGradient, barCells, CHART_CONFIG, useChartId } from "./marks";

/** Hourly metrics open on the day until they have days of shape, then the week. */
export function initialRange(kpi: GoalKpi): HistoryRange {
  const hourly =
    (kpi.metric?.cadenceSeconds ?? Number.POSITIVE_INFINITY) <= 3600;
  if (!hourly) return "1m";
  const days = kpi.trend?.buckets.filter((b) => b.status === "ok").length ?? 0;
  return days >= MIN_DAILY_SHAPE ? "1w" : "1d";
}

function when(t: number, hourly: boolean): string {
  const iso = new Date(t).toISOString();
  return hourly ? `${formatDate(iso)}, ${formatUtcTime(iso)}` : formatDate(iso);
}

export function KpiChart({
  kpi,
  nowIso,
  id: figureId,
}: {
  readonly kpi: GoalKpi;
  readonly nowIso: string;
  /** DOM id, so the card that opens this chart can point at it. */
  readonly id?: string;
}) {
  const metricId = kpi.metric?.id ?? kpi.binding.metricId;
  const display = displayOf(kpi);
  const unit = kpi.binding.target.unit;
  const [range, setRange] = useState<HistoryRange>(() => initialRange(kpi));
  const span = historyWindow(range, Date.parse(nowIso));
  const history = useQuery({
    queryKey: ["goals", "history", metricId, span.from, span.step],
    queryFn: () => fetchMetricHistory(metricId, span),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: 1,
  });
  const titleId = useId();
  const chartId = useChartId("kpi");

  const shown = history.data;
  const hourly = shown?.step === "1h";
  const data = shown ? seriesPoints(shown, kpi) : [];
  const values = data.flatMap((d) => (d.v === null ? [] : [d.v]));
  const target = kpi.binding.target.value;
  const showTarget = targetInView(display, values, kpi.binding);
  const domain = yDomain(
    display,
    values,
    showTarget ? target : null,
    kpi.binding.comparator
  );
  const from = shown ? Date.parse(shown.from) : Date.parse(span.from);
  const to = Math.max(
    (shown ? Date.parse(shown.to) : Date.parse(span.to)) +
      STEP_MS[shown?.step ?? span.step],
    ...data.map((d) => d.t)
  );
  const value = kpi.assessment.value;
  const label = heroLabel(kpi.assessment, nowIso);

  const axes = [
    <CartesianGrid
      key="grid"
      vertical={false}
      strokeDasharray="3 3"
      className="stroke-border/50"
    />,
    <XAxis
      key="x"
      dataKey="t"
      type="number"
      scale="time"
      domain={[from, to]}
      tickLine={false}
      axisLine={false}
      minTickGap={40}
      tickMargin={8}
      tickFormatter={(t: number) =>
        range === "1d"
          ? formatUtcTime(new Date(t).toISOString()).replace(" UTC", "")
          : formatDate(new Date(t).toISOString())
      }
    />,
    <YAxis key="y" hide domain={domain} allowDataOverflow />,
    showTarget ? (
      <ReferenceLine
        key="target"
        y={target}
        stroke="hsl(var(--foreground))"
        strokeOpacity={0.5}
        strokeDasharray="4 4"
        label={{
          value: `${COMPARATOR_SYMBOL[kpi.binding.comparator]} ${formatValue(target, display, unit)}`,
          position: "insideTopRight",
          className: "fill-muted-foreground text-[11px]",
        }}
      />
    ) : null,
    <ChartTooltip
      key="tip"
      cursor={false}
      content={({ active, payload }) => {
        const p = active
          ? (payload?.[0]?.payload as Point | undefined)
          : undefined;
        if (!p) return null;
        return (
          <div className="rounded-md border border-border/60 bg-background px-2 py-1 text-xs shadow-sm">
            <span className="text-muted-foreground">{when(p.t, hourly)} </span>
            <span className="font-medium tabular-nums">
              {p.v === null ? "No reading" : formatValue(p.v, display, unit)}
            </span>
          </div>
        );
      }}
    />,
  ];

  return (
    <figure
      id={figureId}
      aria-labelledby={titleId}
      className="space-y-4 rounded-xl border border-border/60 bg-muted/10 p-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <figcaption
            id={titleId}
            className="font-medium text-muted-foreground text-xs uppercase tracking-wider"
          >
            {kpi.metric?.title ?? metricId}
          </figcaption>
          <div className="mt-1 flex items-end gap-2">
            <span className="font-semibold text-4xl tabular-nums tracking-tight">
              {value === null ? "—" : formatValue(value, display, unit)}
            </span>
            {value !== null && display !== "slo" && (
              <span className="pb-1 text-muted-foreground text-sm">{unit}</span>
            )}
            {label && (
              <span className="pb-1 text-muted-foreground text-xs">
                {label}
              </span>
            )}
          </div>
        </div>
        <ToggleGroup
          type="single"
          value={range}
          onValueChange={(v) => v && setRange(v as HistoryRange)}
          aria-label="Chart range"
          className="rounded-lg border border-border/70 p-1"
        >
          {HISTORY_RANGES.map((r) => (
            <ToggleGroupItem
              key={r.id}
              value={r.id}
              size="sm"
              className="h-7 px-2.5 text-xs"
            >
              {r.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="relative h-48">
        {history.isError && !shown ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            <button
              type="button"
              onClick={() => history.refetch()}
              className="underline-offset-4 hover:underline"
            >
              Couldn’t load · Retry
            </button>
          </div>
        ) : values.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            {history.isPending ? "" : "No data"}
          </div>
        ) : (
          <ChartContainer
            config={CHART_CONFIG}
            className="aspect-auto h-48 w-full [&_.recharts-surface:focus-visible]:outline-2 [&_.recharts-surface:focus-visible]:outline-foreground [&_.recharts-surface:focus-visible]:outline-solid"
          >
            {display === "slo" ? (
              <BarChart
                id={chartId}
                data={data}
                accessibilityLayer
                aria-labelledby={titleId}
                margin={{ top: 16, right: 0, bottom: 0, left: 0 }}
              >
                {axes}
                <Bar
                  id={`${chartId}-bar`}
                  dataKey="v"
                  isAnimationActive={false}
                  radius={2}
                >
                  {barCells(data, kpi.binding)}
                </Bar>
              </BarChart>
            ) : (
              <AreaChart
                id={chartId}
                data={data}
                accessibilityLayer
                aria-labelledby={titleId}
                margin={{ top: 16, right: 0, bottom: 0, left: 0 }}
              >
                {areaGradient(`${chartId}-fill`)}
                {axes}
                <Area
                  id={`${chartId}-area`}
                  dataKey="v"
                  type="monotone"
                  stroke="var(--color-v)"
                  strokeWidth={3}
                  fill={`url(#${chartId}-fill)`}
                  connectNulls={false}
                  dot={
                    values.length < 3
                      ? { r: 4, fill: "var(--color-v)", strokeWidth: 0 }
                      : false
                  }
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              </AreaChart>
            )}
          </ChartContainer>
        )}
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Readings
        </summary>
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {[...data].reverse().flatMap((d) =>
            d.v === null || !d.observationId
              ? []
              : [
                  <li
                    key={d.t}
                    className="flex justify-between gap-3 tabular-nums"
                  >
                    <span className="text-muted-foreground">
                      {when(d.t, hourly)}
                    </span>
                    <Link
                      href={observationHref(metricId, d.observationId)}
                      className="hover:underline"
                    >
                      {formatValue(d.v, display, unit)} ↗
                    </Link>
                  </li>,
                ]
          )}
        </ul>
      </details>
    </figure>
  );
}
