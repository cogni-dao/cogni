// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/data-display/PieChart`
 * Purpose: Reusable pie/donut chart built on shadcn ChartContainer + Recharts.
 * Scope: Kit component. Follows same pattern as ActivityChart — colors via CSS vars from ChartConfig. Does not perform data fetching or server-side logic.
 * Invariants: All Recharts usage goes through ChartContainer/ChartTooltip wrappers.
 * Side-effects: none
 * Links: src/components/vendor/shadcn/chart.tsx, src/components/kit/data-display/ActivityChart.tsx
 * @public
 */

"use client";

import type { ChartConfig } from "@cogni/node-ui-kit/shadcn/chart";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@cogni/node-ui-kit/shadcn/chart";
import type { ReactElement, ReactNode } from "react";
import { Label, Pie, PieChart as RechartsPie } from "recharts";

/**
 * Each datum needs a `name` key matching a key in `config` so CSS vars resolve.
 * `fill` should be `var(--color-<name>)` where name matches a config entry.
 */
export interface PieChartDatum {
  readonly name: string;
  readonly value: number;
  readonly fill: string;
}

interface PieChartProps {
  /** Array of slices. Each `fill` should be `var(--color-<key>)` where key matches a config entry. */
  readonly data: readonly PieChartDatum[];
  /** ChartConfig keyed by the same keys used in data[].name — provides labels + colors. */
  readonly config: ChartConfig;
  /** 0 = pie, >0 = donut. Default 60. */
  readonly innerRadius?: number;
  /** Center label for donut charts. */
  readonly innerLabel?: ReactNode;
  readonly className?: string;
}

export function PieChart({
  data,
  config,
  innerRadius = 60,
  innerLabel,
  className,
}: PieChartProps): ReactElement {
  return (
    <ChartContainer config={config} className={className}>
      <RechartsPie>
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent hideLabel />}
        />
        <Pie
          data={data as PieChartDatum[]}
          dataKey="value"
          nameKey="name"
          innerRadius={innerRadius}
          strokeWidth={2}
          stroke="hsl(var(--background))"
        >
          {innerLabel != null && (
            <Label
              content={() => (
                <text
                  x="50%"
                  y="50%"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="fill-foreground font-bold text-lg"
                >
                  {innerLabel}
                </text>
              )}
            />
          )}
        </Pie>
      </RechartsPie>
    </ChartContainer>
  );
}
