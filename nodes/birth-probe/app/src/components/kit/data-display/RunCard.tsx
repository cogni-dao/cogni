// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/data-display/RunCard`
 * Purpose: Card displaying a single graph run with status indicator, elapsed timer, and metadata.
 * Scope: Presentational only. Does not fetch data or manage state. Receives run data as props.
 * Invariants: Status dot colors follow design system tokens; elapsed timer updates live for running status.
 * Side-effects: timer interval for running status
 * Links: packages/scheduler-core/src/types.ts (GraphRun, GraphRunStatus, GraphRunKind)
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/kit/data-display/Badge";
import { Card } from "@/components/kit/layout/Card";

export interface RunCardData {
  id: string;
  runId: string;
  graphId: string | null;
  runKind: "user_immediate" | "system_scheduled" | "system_webhook" | null;
  status: "pending" | "running" | "success" | "error" | "skipped" | "cancelled";
  /** Human-friendly status label. When set, overrides the default STATUS_CONFIG label.
   *  V0: null (uses defaults like "Running", "Completed").
   *  V0.1: deterministic phase copy ("Thinking", "Using tools").
   *  V1: AI-generated summary from stream content. */
  statusLabel: string | null;
  requestedBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  stateKey: string | null;
}

interface RunCardProps {
  run: RunCardData;
  className?: string;
}

const STATUS_CONFIG = {
  pending: {
    label: "Queued",
    dotClass: "bg-muted-foreground",
    badgeIntent: "secondary" as const,
  },
  running: {
    label: "Running",
    dotClass: "bg-success animate-pulse",
    badgeIntent: "default" as const,
  },
  success: {
    label: "Completed",
    dotClass: "bg-success",
    badgeIntent: "secondary" as const,
  },
  error: {
    label: "Failed",
    dotClass: "bg-destructive",
    badgeIntent: "destructive" as const,
  },
  skipped: {
    label: "Skipped",
    dotClass: "bg-muted-foreground",
    badgeIntent: "outline" as const,
  },
  cancelled: {
    label: "Cancelled",
    dotClass: "bg-muted-foreground",
    badgeIntent: "outline" as const,
  },
} as const;

function formatGraphName(graphId: string | null): string {
  if (!graphId) return "Unknown Graph";
  // "langgraph:poet" → "Poet", "inproc:chat" → "Chat"
  const name = graphId.includes(":") ? graphId.split(":").pop() : graphId;
  if (!name) return graphId;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function formatRunKind(kind: RunCardData["runKind"]): string {
  switch (kind) {
    case "user_immediate":
      return "User";
    case "system_scheduled":
      return "Scheduled";
    case "system_webhook":
      return "Webhook";
    default:
      return "Run";
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function ElapsedTimer({ startedAt }: { startedAt: string }): ReactElement {
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
  );

  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(
        Math.max(
          0,
          Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
        )
      );
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <span className="font-medium text-muted-foreground text-sm tabular-nums">
      {formatDuration(elapsed)}
    </span>
  );
}

function StaticDuration({
  startedAt,
  completedAt,
}: {
  startedAt: string;
  completedAt: string;
}): ReactElement {
  const seconds = Math.max(
    0,
    Math.floor(
      (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000
    )
  );
  return (
    <span className="text-muted-foreground text-sm">
      {formatDuration(seconds)}
    </span>
  );
}

export function RunCard({ run, className }: RunCardProps): ReactElement {
  const config = STATUS_CONFIG[run.status];
  const displayLabel = run.statusLabel ?? config.label;

  return (
    <Card
      className={cn(
        "relative overflow-hidden transition-colors",
        run.status === "running" && "border-primary/40",
        run.status === "error" && "border-destructive/40",
        className
      )}
    >
      <div className="flex flex-col gap-3 p-4">
        {/* Header row: status dot + graph name + elapsed */}
        <div className="flex items-center gap-3">
          <span
            className={cn("size-2.5 shrink-0 rounded-full", config.dotClass)}
            role="img"
            aria-label={displayLabel}
          />
          <span className="min-w-0 flex-1 truncate font-semibold text-sm">
            {formatGraphName(run.graphId)}
          </span>
          {run.status === "running" && run.startedAt && (
            <ElapsedTimer startedAt={run.startedAt} />
          )}
          {(run.status === "success" || run.status === "error") &&
            run.startedAt &&
            run.completedAt && (
              <StaticDuration
                startedAt={run.startedAt}
                completedAt={run.completedAt}
              />
            )}
        </div>

        {/* Meta row: kind badge + status badge + error */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge intent="outline" size="sm">
            {formatRunKind(run.runKind)}
          </Badge>
          <Badge intent={config.badgeIntent} size="sm">
            {displayLabel}
          </Badge>
          {run.errorCode && (
            <Badge intent="destructive" size="sm">
              {run.errorCode}
            </Badge>
          )}
        </div>

        {/* Error message */}
        {run.errorMessage && (
          <p className="line-clamp-2 text-destructive text-xs">
            {run.errorMessage}
          </p>
        )}

        {/* Timestamp */}
        {run.startedAt && (
          <time
            className="text-muted-foreground text-xs"
            dateTime={run.startedAt}
          >
            {new Date(run.startedAt).toLocaleString()}
          </time>
        )}
      </div>
    </Card>
  );
}
