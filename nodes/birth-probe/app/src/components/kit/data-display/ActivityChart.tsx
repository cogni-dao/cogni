// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/data-display/ActivityChart`
 * Purpose: Reusable stacked bar chart component for activity metrics with per-model breakdown.
 * Scope: Renders a single metric chart. Does not fetch data.
 * Invariants: Uses Recharts and shadcn/chart.
 * Side-effects: none
 * Links: [ActivityView](../../../app/(app)/activity/view.tsx)
 * @public
 */

"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cogni/node-ui-kit/shadcn/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@cogni/node-ui-kit/shadcn/chart";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";

export interface ActivityChartProps {
  title: string;
  description: string;
  /** Each data point has `date` plus one numeric key per model/series */
  data: Record<string, unknown>[];
  /** Keys in config correspond to data keys (model names or "value" for single-series) */
  config: ChartConfig;
  /** Bucket granularity: "5m" | "15m" | "1h" | "6h" | "1d" */
  effectiveStep?: string;
}

export function ActivityChart({
  title,
  description,
  data,
  config,
  effectiveStep,
}: ActivityChartProps) {
  const formatTick = (value: string) => {
    const date = new Date(value);
    if (effectiveStep && effectiveStep !== "1d") {
      return date.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    }
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  };

  const formatTooltipLabel = (value: string) => {
    const date = new Date(value);
    if (effectiveStep && effectiveStep !== "1d") {
      return date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    }
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  };

  // Derive series keys from config (each key maps to a Bar)
  const seriesKeys = Object.keys(config);

  return (
    <Card>
      <CardHeader className="pt-4 pb-2 sm:pt-5 sm:pb-3">
        <div className="grid flex-1 gap-0.5">
          <CardTitle className="font-medium text-muted-foreground text-sm">
            {title}
          </CardTitle>
          <CardDescription className="font-bold text-foreground text-lg">
            {description}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="px-2 pb-2 sm:px-4">
        <ChartContainer config={config} className="aspect-auto h-36 w-full">
          <BarChart data={data} barCategoryGap="6%" barSize={14}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={formatTick}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={formatTooltipLabel}
                  indicator="dot"
                />
              }
            />
            {seriesKeys.map((key, i) => (
              <Bar
                key={key}
                dataKey={key}
                stackId="a"
                fill={`var(--color-${key})`}
                radius={
                  i === seriesKeys.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]
                }
              />
            ))}
            <ChartLegend content={<ChartLegendContent />} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
