// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/system/view`
 * Purpose: Client component displaying DAO system activity — credit balance, upcoming runs, recent runs, and activity charts.
 * Scope: Renders governance data fetched via React Query hooks. Does not perform server-side logic or direct DB access.
 * Invariants: Layout container owned by gov/layout.tsx; 30s polling for status, stale-while-revalidate for activity.
 * Side-effects: IO (via useGovernanceStatus hook and activity fetch)
 * Links: docs/spec/governance-status-api.md
 * @public
 */

"use client";

import type {
  ActivityGroupBy,
  aiActivityOperation,
  TimeRange,
} from "@cogni/node-contracts";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import type { z } from "zod";
import {
  SectionCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TimeRangeSelector,
  ToggleGroup,
  ToggleGroupItem,
} from "@/components";
import { ActivityChart } from "@/components/kit/data-display/ActivityChart";
import {
  buildAggregateChartData,
  buildGroupedChartData,
} from "@/components/kit/data-display/activity-chart-utils";
import { useGovernanceStatus } from "@/features/governance/hooks/useGovernanceStatus";
import { creditsToUsd } from "@/features/payments/public";
import { fetchGovernanceActivity } from "../_api/fetchGovernanceActivity";

export function GovernanceView(): ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const range = (searchParams.get("range") as TimeRange) || "1d";
  const [groupBy, setGroupBy] = useState<ActivityGroupBy | undefined>("model");

  const { data, isLoading, error } = useGovernanceStatus();

  const {
    data: activity,
    isLoading: activityLoading,
    error: activityError,
  } = useQuery({
    queryKey: ["governance-activity", range, groupBy],
    queryFn: () =>
      fetchGovernanceActivity({ range, ...(groupBy && { groupBy }) }),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 2,
  });

  const handleRangeChange = (newRange: TimeRange) => {
    router.replace(`/gov/system?range=${newRange}`, { scroll: false });
  };

  // Error state — matches activity/schedules pattern
  if (error) {
    return (
      <div className="flex flex-col gap-6">
        <div className="rounded-lg border border-destructive bg-destructive/10 p-6">
          <h2 className="font-semibold text-destructive text-lg">
            Error loading governance data
          </h2>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  // Loading skeleton — matches activity page pattern
  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-6">
        <div className="animate-pulse space-y-8">
          <div className="h-8 w-64 rounded-md bg-muted" />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="h-32 rounded-lg bg-muted" />
            <div className="h-32 rounded-lg bg-muted" />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="h-48 rounded-lg bg-muted" />
            <div className="h-48 rounded-lg bg-muted" />
            <div className="h-48 rounded-lg bg-muted" />
          </div>
          <div className="h-48 rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-bold text-2xl tracking-tight">
        Cogni System Activity
      </h1>

      {/* Stats row */}
      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="System Credit Balance">
          <span className="font-bold text-4xl">
            $
            {creditsToUsd(Number(data.systemCredits)).toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
          <span className="ml-2 text-lg text-muted-foreground">USD</span>
        </SectionCard>

        <SectionCard title="Upcoming Runs">
          {data.upcomingRuns.length === 0 ? (
            <span className="text-muted-foreground">No runs scheduled</span>
          ) : (
            <ul className="space-y-3">
              {data.upcomingRuns.map((run) => (
                <li
                  key={run.name}
                  className="flex items-baseline justify-between gap-4"
                >
                  <span className="text-muted-foreground">{run.name}</span>
                  <Countdown target={new Date(run.nextRunAt)} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      {/* Activity charts */}
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="font-semibold text-xl tracking-tight">
            Usage Metrics
          </h2>
          <div className="flex items-center gap-3">
            <ToggleGroup
              type="single"
              value={groupBy ?? ""}
              onValueChange={(v) =>
                setGroupBy((v as ActivityGroupBy) || undefined)
              }
              className="rounded-lg border"
            >
              <ToggleGroupItem value="model" className="px-3 text-xs">
                By Model
              </ToggleGroupItem>
              <ToggleGroupItem value="graphId" className="px-3 text-xs">
                By Agent
              </ToggleGroupItem>
            </ToggleGroup>
            <TimeRangeSelector
              value={range}
              onValueChange={handleRangeChange}
              className="w-40 rounded-lg"
            />
          </div>
        </div>

        {activityError ? (
          <div className="rounded-lg border border-destructive bg-destructive/10 p-6">
            <p className="text-destructive text-sm">
              Failed to load activity charts.
            </p>
          </div>
        ) : activityLoading || !activity ? (
          <div className="grid animate-pulse gap-4 md:grid-cols-3">
            <div className="h-48 rounded-lg bg-muted" />
            <div className="h-48 rounded-lg bg-muted" />
            <div className="h-48 rounded-lg bg-muted" />
          </div>
        ) : (
          <ActivityCharts activity={activity} />
        )}
      </div>

      {/* Recent Runs table */}
      <div className="space-y-4">
        <h2 className="font-semibold text-xl tracking-tight">Recent Runs</h2>
        {data.recentRuns.length === 0 ? (
          <div className="rounded-lg border bg-card p-12 text-center">
            <p className="text-muted-foreground">No recent activity</p>
            <p className="mt-2 text-muted-foreground text-sm">
              System activity will appear here once scheduled runs execute.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Last Activity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="font-medium">
                      {run.title ?? run.id}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(run.startedAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(run.lastActivity).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

function Countdown({ target }: { target: Date }) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.floor((target.getTime() - Date.now()) / 1000))
  );

  useEffect(() => {
    const tick = () => {
      setSecondsLeft(
        Math.max(0, Math.floor((target.getTime() - Date.now()) / 1000))
      );
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);

  if (secondsLeft === 0) {
    return <span className="font-semibold text-muted-foreground">now</span>;
  }

  const h = Math.floor(secondsLeft / 3600);
  const m = Math.floor((secondsLeft % 3600) / 60);
  const s = secondsLeft % 60;

  return (
    <span className="font-semibold tabular-nums">
      {h > 0 && (
        <>
          {h}
          <span className="font-normal text-muted-foreground">h </span>
        </>
      )}
      {(h > 0 || m > 0) && (
        <>
          {m}
          <span className="font-normal text-muted-foreground">m </span>
        </>
      )}
      {String(s).padStart(2, "0")}
      <span className="font-normal text-muted-foreground">s</span>
    </span>
  );
}

type ActivityData = z.infer<typeof aiActivityOperation.output>;

function ActivityCharts({ activity }: { activity: ActivityData }) {
  const { chartSeries, groupedSeries, effectiveStep } = activity;
  const hasGrouped = groupedSeries && groupedSeries.length > 0;

  const spend = hasGrouped
    ? buildGroupedChartData(groupedSeries, "spend")
    : buildAggregateChartData(
        chartSeries,
        "spend",
        "Spend ($)",
        "hsl(var(--chart-1))"
      );

  const tokens = hasGrouped
    ? buildGroupedChartData(groupedSeries, "tokens")
    : buildAggregateChartData(
        chartSeries,
        "tokens",
        "Tokens",
        "hsl(var(--chart-2))"
      );

  const requests = hasGrouped
    ? buildGroupedChartData(groupedSeries, "requests")
    : buildAggregateChartData(
        chartSeries,
        "requests",
        "Requests",
        "hsl(var(--chart-3))"
      );

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <ActivityChart
        title="Spend"
        description={`$${activity.totals.spend.total}`}
        data={spend.data}
        config={spend.config}
        effectiveStep={effectiveStep}
      />
      <ActivityChart
        title="Tokens"
        description={activity.totals.tokens.total.toLocaleString()}
        data={tokens.data}
        config={tokens.config}
        effectiveStep={effectiveStep}
      />
      <ActivityChart
        title="Requests"
        description={activity.totals.requests.total.toLocaleString()}
        data={requests.data}
        config={requests.config}
        effectiveStep={effectiveStep}
      />
    </div>
  );
}
