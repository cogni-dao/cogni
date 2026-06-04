// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/data-display/activity-chart-utils`
 * Purpose: Transform grouped activity series into the flat data shape consumed by ActivityChart.
 * Scope: Pure data transforms, no IO, no React. Does not render components or fetch data.
 * Invariants: Output keys are sanitized for CSS variable compatibility (used as --color-<key>).
 * Side-effects: none
 * Links: [ActivityChart](./ActivityChart.tsx)
 * @internal
 */

import type { ChartConfig } from "@cogni/node-ui-kit/shadcn/chart";

/** Palette for per-group bar colors — theme chart vars at 70% for a subdued look. */
const GROUP_COLORS = [
  "hsl(var(--chart-1) / 0.7)", // blue
  "hsl(var(--chart-3) / 0.7)", // amber
  "hsl(var(--chart-4) / 0.7)", // purple
  "hsl(var(--chart-5) / 0.7)", // rose
  "hsl(var(--chart-2) / 0.7)", // teal
  "hsl(var(--chart-3) / 0.35)", // Others — faded amber
] as const;

type GroupedSeriesEntry = {
  group: string;
  buckets: Array<{
    bucketStart: string;
    spend: number;
    tokens: number;
    requests: number;
  }>;
};

/** Sanitize a group name into a valid CSS/recharts data key. */
function toDataKey(group: string): string {
  return group.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

type Metric = "spend" | "tokens" | "requests";

/**
 * Flatten groupedSeries into a single array of records keyed by sanitized group names,
 * plus a ChartConfig mapping each key to its label and color.
 */
export function buildGroupedChartData(
  groupedSeries: readonly GroupedSeriesEntry[],
  metric: Metric
): { data: Record<string, unknown>[]; config: ChartConfig } {
  // All groups share the same bucket timestamps — use the first group as reference
  const bucketCount = groupedSeries[0]?.buckets.length ?? 0;

  const config: ChartConfig = {};
  const dataKeys: { key: string; group: GroupedSeriesEntry }[] = [];

  for (const [i, entry] of groupedSeries.entries()) {
    const key = toDataKey(entry.group);
    const color =
      GROUP_COLORS[Math.min(i, GROUP_COLORS.length - 1)] ?? GROUP_COLORS[0];
    config[key] = { label: entry.group, color };
    dataKeys.push({ key, group: entry });
  }

  const ref = groupedSeries[0];
  if (!ref) return { data: [], config };

  const data: Record<string, unknown>[] = [];
  for (let b = 0; b < bucketCount; b++) {
    const point: Record<string, unknown> = {
      date: ref.buckets[b]?.bucketStart,
    };
    for (const { key, group } of dataKeys) {
      point[key] = group.buckets[b]?.[metric];
    }
    data.push(point);
  }

  return { data, config };
}

/**
 * Build simple single-series chart data from aggregate chartSeries.
 * Used when no groupBy is active.
 */
export function buildAggregateChartData(
  chartSeries: ReadonlyArray<{
    bucketStart: string;
    spend: string;
    tokens: number;
    requests: number;
  }>,
  metric: Metric,
  label: string,
  color: string
): { data: Record<string, unknown>[]; config: ChartConfig } {
  const config: ChartConfig = {
    value: { label, color },
  };

  const data = chartSeries.map((d) => ({
    date: d.bucketStart,
    value: metric === "spend" ? Number.parseFloat(d.spend) : d[metric],
  }));

  return { data, config };
}
