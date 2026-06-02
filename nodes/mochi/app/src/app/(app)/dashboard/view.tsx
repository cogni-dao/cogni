// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/view`
 * Purpose: Unified operations dashboard — runs table (deduplicated by thread), active work items, and activity charts.
 * Scope: Client-side view managing data fetching via React Query. Does not implement business logic.
 * Invariants:
 *   - Polls runs at 5s, work items at 30s, activity at 30s
 *   - Runs deduplicated by stateKey (one row per conversation thread)
 *   - "System Runs" tab shows system-scoped runs and activity
 *   - Activity charts scope matches active tab (user or system)
 * Side-effects: IO (via React Query)
 * Links: [fetchRuns](./_api/fetchRuns.ts), [fetchActivity](../activity/_api/fetchActivity.ts), [ActivityChart](../../../components/kit/data-display/ActivityChart.tsx)
 * @public
 */

"use client";

import type {
  ActivityGroupBy,
  TimeRange,
  WorkItemDto,
} from "@cogni/node-contracts";
import { cn } from "@cogni/node-ui-kit/util/cn";
import { useQuery } from "@tanstack/react-query";
import { Radio } from "lucide-react";
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
import { fetchActivity } from "../activity/_api/fetchActivity";
import { WorkItemDetail } from "../work/_components/WorkItemDetail";
import { StatusPill, TypeIcon } from "../work/_components/work-item-icons";
import { fetchRuns } from "./_api/fetchRuns";

type Tab = "user" | "system";

/* ─── helpers ─── */

function formatGraphName(graphId: string | null): string {
  if (!graphId) return "Unknown";
  const name = graphId.includes(":") ? graphId.split(":").pop() : graphId;
  if (!name) return graphId;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(startedAt: string, completedAt: string): string {
  const seconds = Math.max(
    0,
    Math.floor(
      (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000
    )
  );
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
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
  const statusOrder: Record<string, number> = {
    running: 0,
    pending: 1,
    error: 2,
    success: 3,
    skipped: 4,
    cancelled: 5,
  };
  return [...runs].sort((a, b) => {
    const aOrder = statusOrder[a.status] ?? 99;
    const bOrder = statusOrder[b.status] ?? 99;
    if (aOrder !== bOrder) return aOrder - bOrder;
    const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return bTime - aTime;
  });
}

function badgeIntent(status: string): "destructive" | "default" | "secondary" {
  if (status === "error") return "destructive";
  if (status === "running") return "default";
  return "secondary";
}

/** Deduplicate runs by stateKey (or graphId for runs without stateKey).
 *  Keeps the most recent run per conversation thread. */
function dedupeByThread(runs: RunCardData[]): RunCardData[] {
  const seen = new Map<string, RunCardData>();
  for (const run of runs) {
    // Chat runs: dedup by thread (stateKey). System/webhook runs: each run is unique.
    const key = run.stateKey ?? run.runId ?? run.id;
    if (!seen.has(key)) {
      seen.set(key, run);
    }
  }
  return [...seen.values()];
}

/* ─── data fetchers ─── */

async function fetchWorkItems(): Promise<{ items: WorkItemDto[] }> {
  try {
    const res = await fetch("/api/v1/work/items");
    if (res.ok) return res.json();
    if (res.status === 404) return { items: [] };
    throw new Error(`Failed to fetch work items: ${res.status}`);
  } catch (err) {
    if (err instanceof TypeError) return { items: [] };
    throw err;
  }
}

/* ─── main view ─── */

export function DashboardView(): ReactElement {
  const [tab, setTab] = useState<Tab>("user");
  const [activityRange, setActivityRange] = useState<TimeRange>("1d");
  const [activityGroupBy, setActivityGroupBy] = useState<
    ActivityGroupBy | undefined
  >("model");
  const [selectedWorkItem, setSelectedWorkItem] = useState<WorkItemDto | null>(
    null
  );

  const { data: runsData, isLoading: runsLoading } = useQuery({
    queryKey: ["dashboard-runs", tab],
    queryFn: () => fetchRuns({ tab, limit: 5 }),
    refetchInterval: 5_000,
    staleTime: 3_000,
    gcTime: 60_000,
  });

  const { data: workData, isLoading: workLoading } = useQuery({
    queryKey: ["dashboard-work"],
    queryFn: fetchWorkItems,
    staleTime: 30_000,
    gcTime: 60_000,
  });

  const { data: activityData, isLoading: activityLoading } = useQuery({
    queryKey: ["dashboard-activity", activityRange, activityGroupBy, tab],
    queryFn: () =>
      fetchActivity({
        range: activityRange,
        ...(tab === "system" && { scope: "system" as const }),
        ...(activityGroupBy && { groupBy: activityGroupBy }),
      }),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 2,
  });

  const runs = runsData?.runs ? sortRuns(runsData.runs) : [];
  const agents = dedupeByThread(runs);
  const activeCount = runs.filter((r) => r.status === "running").length;

  const workItems = (workData?.items ?? [])
    .filter((i) => i.status !== "done" && i.status !== "cancelled")
    .slice(0, 5);

  // Activity chart data
  const hasActivity = activityData && !activityLoading;
  const groupedSeries =
    hasActivity && activityData.groupedSeries?.length
      ? activityData.groupedSeries
      : null;

  const spend = hasActivity
    ? groupedSeries
      ? buildGroupedChartData(groupedSeries, "spend")
      : buildAggregateChartData(
          activityData.chartSeries,
          "spend",
          "Spend ($)",
          "hsl(var(--chart-1))"
        )
    : null;

  const tokens = hasActivity
    ? groupedSeries
      ? buildGroupedChartData(groupedSeries, "tokens")
      : buildAggregateChartData(
          activityData.chartSeries,
          "tokens",
          "Tokens",
          "hsl(var(--chart-2))"
        )
    : null;

  const requests = hasActivity
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
    <div className="flex flex-col gap-6 p-5 md:p-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-bold text-2xl tracking-tight">Dashboard</h1>
          {activeCount > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-0.5 font-medium text-sm text-success">
              <Radio className="size-3.5 animate-pulse" />
              {activeCount} active
            </span>
          )}
        </div>
        <ToggleGroup
          type="single"
          value={tab}
          onValueChange={(v) => {
            if (v) setTab(v as Tab);
          }}
          className="rounded-lg border"
        >
          <ToggleGroupItem value="user" className="px-3 text-xs">
            My Runs
          </ToggleGroupItem>
          <ToggleGroupItem value="system" className="px-3 text-xs">
            System Runs
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Two-column top section: Agents + Work */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left — Agents */}
        <Card>
          <CardHeader className="px-5 py-3">
            <CardTitle className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
              {tab === "system" ? "System Runs" : "Recent Runs"}
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
                    const threadHref = run.stateKey
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
                          />
                        </TableCell>
                        <TableCell className="font-medium text-sm">
                          {threadHref ? (
                            <Link href={threadHref} className="hover:underline">
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
                              ? "..."
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
                {tab === "system"
                  ? "No system runs yet. Create a schedule to get started."
                  : "No recent runs. Start a conversation to see runs here."}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Right — Work Items */}
        <Card>
          <CardHeader className="px-5 py-3">
            <div className="flex items-center justify-between">
              <CardTitle className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                Active Work
              </CardTitle>
              <Link
                href="/work"
                className="text-muted-foreground text-xs hover:text-foreground"
              >
                View all &rarr;
              </Link>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {workLoading ? (
              <div className="animate-pulse space-y-px px-5 pb-4">
                <div className="h-9 rounded bg-muted" />
                <div className="h-9 rounded bg-muted" />
                <div className="h-9 rounded bg-muted" />
              </div>
            ) : workItems.length > 0 ? (
              <div className="divide-y divide-border">
                {workItems.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-muted/50"
                    onClick={() => setSelectedWorkItem(item)}
                  >
                    <TypeIcon type={item.type} className="size-3.5 shrink-0" />
                    <StatusPill status={item.status} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {item.title}
                    </span>
                    {item.priority !== undefined && (
                      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                        P{item.priority}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <p className="px-5 py-4 text-center text-muted-foreground text-sm">
                No active work items
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Activity Section */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
            Activity
          </h2>
          <div className="flex items-center gap-3">
            <ToggleGroup
              type="single"
              value={activityGroupBy ?? ""}
              onValueChange={(v) =>
                setActivityGroupBy((v as ActivityGroupBy) || undefined)
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

      <WorkItemDetail
        item={selectedWorkItem}
        open={selectedWorkItem !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedWorkItem(null);
        }}
      />
    </div>
  );
}
