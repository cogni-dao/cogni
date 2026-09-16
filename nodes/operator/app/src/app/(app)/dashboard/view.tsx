// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/view`
 * Purpose: Signed-in node operations home with personal AI activity as a secondary disclosure.
 * Scope: Client-side refresh and presentation. Business reads live behind typed APIs/facades.
 * Invariants: NODES_FIRST, USER_SCOPE_ONLY, NO_PROCESS_HEALTH, NO_GLOBAL_WORK.
 * Side-effects: IO (React Query)
 * Links: /api/v1/dashboard/nodes, task.5112
 * @public
 */

"use client";

import type {
  ActivityGroupBy,
  NodeOperationsOverviewOutput,
  TimeRange,
} from "@cogni/node-contracts";
import { nodeOperationsOverviewOperation } from "@cogni/node-contracts";
import { cn } from "@cogni/node-ui-kit/util/cn";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";
import { useState } from "react";

import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
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
import type { RunCardData } from "@/components/kit/data-display/RunCard";
import { NodeOperationsTable } from "@/features/nodes/operations/NodeOperationsTable.client";

import { fetchActivity } from "../activity/_api/fetchActivity";
import { fetchRuns } from "./_api/fetchRuns";

function formatGraphName(graphId: string | null): string {
  if (!graphId) return "Unknown";
  const name = graphId.includes(":") ? graphId.split(":").pop() : graphId;
  if (!name) return graphId;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDuration(startedAt: string, completedAt: string): string {
  const seconds = Math.max(
    0,
    Math.floor(
      (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000
    )
  );
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const STATUS_DOT: Record<string, string> = {
  running: "bg-success animate-pulse",
  pending: "bg-muted-foreground animate-pulse",
  success: "bg-success",
  error: "bg-destructive",
  skipped: "bg-muted-foreground",
  cancelled: "bg-muted-foreground",
};

const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  pending: "Queued",
  success: "Completed",
  error: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

function sortRuns(runs: RunCardData[]): RunCardData[] {
  const order: Record<string, number> = {
    running: 0,
    pending: 1,
    error: 2,
    success: 3,
    skipped: 4,
    cancelled: 5,
  };
  return [...runs].sort((left, right) => {
    const status = (order[left.status] ?? 99) - (order[right.status] ?? 99);
    if (status !== 0) return status;
    return (
      new Date(right.startedAt ?? 0).getTime() -
      new Date(left.startedAt ?? 0).getTime()
    );
  });
}

function dedupeByThread(runs: RunCardData[]): RunCardData[] {
  const seen = new Map<string, RunCardData>();
  for (const run of runs) {
    const key = run.stateKey ?? run.runId ?? run.id;
    if (!seen.has(key)) seen.set(key, run);
  }
  return [...seen.values()];
}

function badgeIntent(status: string): "destructive" | "default" | "secondary" {
  if (status === "error") return "destructive";
  if (status === "running") return "default";
  return "secondary";
}

async function fetchNodeOperations(): Promise<NodeOperationsOverviewOutput> {
  const response = await fetch("/api/v1/dashboard/nodes");
  if (!response.ok)
    throw new Error(`Node operations failed: ${response.status}`);
  return nodeOperationsOverviewOperation.output.parse(await response.json());
}

export function DashboardView({
  initialNodes,
}: {
  initialNodes: NodeOperationsOverviewOutput;
}): ReactElement {
  const [activityRange, setActivityRange] = useState<TimeRange>("1d");
  const [activityGroupBy, setActivityGroupBy] = useState<
    ActivityGroupBy | undefined
  >("model");

  const { data: nodeData } = useQuery({
    queryKey: ["node-operations"],
    queryFn: fetchNodeOperations,
    initialData: initialNodes,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const { data: runsData, isLoading: runsLoading } = useQuery({
    queryKey: ["dashboard-runs", "user"],
    queryFn: () => fetchRuns({ tab: "user", limit: 5 }),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
  const { data: activityData, isLoading: activityLoading } = useQuery({
    queryKey: ["dashboard-activity", activityRange, activityGroupBy, "user"],
    queryFn: () =>
      fetchActivity({
        range: activityRange,
        ...(activityGroupBy && { groupBy: activityGroupBy }),
      }),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 2,
  });

  const agents = dedupeByThread(sortRuns(runsData?.runs ?? []));
  const groupedSeries = activityData?.groupedSeries?.length
    ? activityData.groupedSeries
    : null;
  const spend = activityData
    ? groupedSeries
      ? buildGroupedChartData(groupedSeries, "spend")
      : buildAggregateChartData(
          activityData.chartSeries,
          "spend",
          "Spend ($)",
          "hsl(var(--chart-1))"
        )
    : null;
  const tokens = activityData
    ? groupedSeries
      ? buildGroupedChartData(groupedSeries, "tokens")
      : buildAggregateChartData(
          activityData.chartSeries,
          "tokens",
          "Tokens",
          "hsl(var(--chart-2))"
        )
    : null;
  const requests = activityData
    ? groupedSeries
      ? buildGroupedChartData(groupedSeries, "requests")
      : buildAggregateChartData(
          activityData.chartSeries,
          "requests",
          "Requests",
          "hsl(var(--chart-3))"
        )
    : null;

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-5 md:p-6">
      <NodeOperationsTable nodes={nodeData.nodes} />

      <details className="group rounded-lg border bg-card">
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between rounded-lg px-4 font-medium hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          <span>Your AI usage</span>
          <ChevronDown
            className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>

        <div className="space-y-6 border-t p-4 md:p-5">
          <Card>
            <CardHeader className="px-5 py-3">
              <CardTitle className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                Recent runs
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {runsLoading ? (
                <div className="animate-pulse space-y-px px-5 pb-4">
                  <div className="h-10 rounded bg-muted" />
                  <div className="h-10 rounded bg-muted" />
                </div>
              ) : agents.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8" />
                      <TableHead>Agent</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Duration</TableHead>
                      <TableHead className="text-right">When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agents.map((run) => {
                      const href = run.stateKey
                        ? `/chat?thread=${encodeURIComponent(run.stateKey)}`
                        : null;
                      return (
                        <TableRow key={run.stateKey ?? run.id}>
                          <TableCell className="pr-0">
                            <span
                              className={cn(
                                "inline-block size-2 rounded-full",
                                STATUS_DOT[run.status] ?? "bg-muted-foreground"
                              )}
                              aria-hidden="true"
                            />
                          </TableCell>
                          <TableCell className="font-medium text-sm">
                            {href ? (
                              <Link href={href} className="hover:underline">
                                {formatGraphName(run.graphId)}
                              </Link>
                            ) : (
                              formatGraphName(run.graphId)
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge intent={badgeIntent(run.status)} size="sm">
                              {run.statusLabel ??
                                STATUS_LABEL[run.status] ??
                                run.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground text-sm tabular-nums">
                            {run.startedAt && run.completedAt
                              ? formatDuration(run.startedAt, run.completedAt)
                              : run.status === "running"
                                ? "…"
                                : "—"}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground text-sm">
                            {run.startedAt ? timeAgo(run.startedAt) : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <p className="px-5 py-6 text-center text-muted-foreground text-sm">
                  No recent runs
                </p>
              )}
            </CardContent>
          </Card>

          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                Activity
              </h2>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <ToggleGroup
                  type="single"
                  value={activityGroupBy ?? ""}
                  onValueChange={(value) =>
                    setActivityGroupBy((value as ActivityGroupBy) || undefined)
                  }
                  className="rounded-lg border"
                >
                  <ToggleGroupItem value="model" className="px-3 text-xs">
                    By model
                  </ToggleGroupItem>
                  <ToggleGroupItem value="graphId" className="px-3 text-xs">
                    By agent
                  </ToggleGroupItem>
                </ToggleGroup>
                <TimeRangeSelector
                  value={activityRange}
                  onValueChange={setActivityRange}
                  className="w-40 rounded-lg"
                />
              </div>
            </div>

            {activityLoading ? (
              <div className="grid animate-pulse gap-4 md:grid-cols-3">
                <div className="h-48 rounded-lg bg-muted" />
                <div className="h-48 rounded-lg bg-muted" />
                <div className="h-48 rounded-lg bg-muted" />
              </div>
            ) : spend && tokens && requests && activityData ? (
              <div className="grid gap-4 md:grid-cols-3">
                <ActivityChart
                  title="Spend"
                  description={`$${activityData.totals.spend.total}`}
                  data={spend.data}
                  config={spend.config}
                  effectiveStep={activityData.effectiveStep}
                />
                <ActivityChart
                  title="Tokens"
                  description={activityData.totals.tokens.total.toLocaleString()}
                  data={tokens.data}
                  config={tokens.config}
                  effectiveStep={activityData.effectiveStep}
                />
                <ActivityChart
                  title="Requests"
                  description={activityData.totals.requests.total.toLocaleString()}
                  data={requests.data}
                  config={requests.config}
                  effectiveStep={activityData.effectiveStep}
                />
              </div>
            ) : null}
          </div>
        </div>
      </details>
    </div>
  );
}
