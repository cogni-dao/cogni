// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/lib/build-pie-data`
 * Purpose: Build PieChart data + ChartConfig from named slices. Same pattern as activity-chart-utils.
 * Scope: Pure data transforms, no IO, no React. Does not render components or fetch data.
 * Invariants: Keys are sanitized for CSS variable compatibility. Colors use --chart-N theme vars.
 * Side-effects: none
 * Links: src/components/kit/data-display/activity-chart-utils.ts
 * @internal
 */

/** Same palette order as activity-chart-utils GROUP_COLORS. */
const COLORS = [
  "hsl(var(--chart-1) / 0.7)",
  "hsl(var(--chart-3) / 0.7)",
  "hsl(var(--chart-4) / 0.7)",
  "hsl(var(--chart-5) / 0.7)",
  "hsl(var(--chart-2) / 0.7)",
];

function toDataKey(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

/** Slice for the pie chart — matches PieChartDatum shape. */
type Datum = { name: string; value: number; fill: string };

/** Minimal ChartConfig shape — { [key]: { label, color } }. */
type Config = Record<string, { label: string; color: string }>;

/** Legend entry for rendering a vertical legend alongside the chart. */
export type LegendEntry = { label: string; color: string; value: number };

/**
 * Build chart data + config for PieChart from a list of { key, value } slices.
 * Returns `chartData` with `fill: var(--color-<key>)`, a `chartConfig` with matching colors,
 * and `legendEntries` for rendering a custom vertical legend.
 */
export function buildPieChartData(
  slices: readonly { key: string; value: number }[]
): { chartData: Datum[]; chartConfig: Config; legendEntries: LegendEntry[] } {
  const chartConfig: Config = {};
  const chartData: Datum[] = [];
  const legendEntries: LegendEntry[] = [];

  for (const [i, slice] of slices.entries()) {
    const dataKey = toDataKey(slice.key);
    const color = COLORS[i % COLORS.length] as string;

    chartConfig[dataKey] = { label: slice.key, color };
    chartData.push({
      name: dataKey,
      value: slice.value,
      fill: `var(--color-${dataKey})`,
    });
    legendEntries.push({ label: slice.key, color, value: slice.value });
  }

  return { chartData, chartConfig, legendEntries };
}
