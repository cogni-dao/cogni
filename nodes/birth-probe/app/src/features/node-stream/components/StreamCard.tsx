// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-stream/components/StreamCard`
 * Purpose: Universal card shell for node stream events — status dot, type badge, source, age, children slot.
 * Scope: Presentational only. Does not fetch data or subscribe to streams.
 * Invariants:
 *   - PRESENTATIONAL_CARDS: Receives event as props, no fetching
 *   - KIT_REUSE: Uses existing Card/Badge components
 * Side-effects: none
 * Links: @cogni/node-streams, @features/node-stream/hooks/useNodeStream
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import type { ReactElement, ReactNode } from "react";
import { Badge, Card, CardContent, CardHeader } from "@/components";
import type { StreamEvent } from "../hooks/useNodeStream";

interface StreamCardProps {
  /** The event to display. When undefined, renders empty state. */
  event: StreamEvent | undefined;
  /** Event-specific content. */
  children: ReactNode;
  /** Optional CSS class for layout overrides. */
  className?: string;
}

/** Format relative age from ISO timestamp (e.g., "12s ago", "3m ago"). */
function formatAge(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/**
 * Card shell for a single node stream event.
 *
 * Header: status dot + event type badge + source + relative age.
 * Body: children slot for event-specific content.
 */
export function StreamCard({
  event,
  children,
  className,
}: StreamCardProps): ReactElement {
  if (!event) {
    return (
      <Card className={cn("opacity-50", className)}>
        <CardHeader className="flex flex-row items-center gap-2 px-4 py-3">
          <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
          <span className="text-muted-foreground text-xs">
            Waiting for events…
          </span>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center gap-2 px-4 py-3">
        <StatusDot event={event} />
        <Badge intent="outline" size="sm">
          {event.type}
        </Badge>
        <span className="text-muted-foreground text-xs">{event.source}</span>
        <span className="ml-auto text-muted-foreground text-xs">
          {formatAge(event.timestamp)}
        </span>
      </CardHeader>
      <CardContent className="px-4 pt-0 pb-3">{children}</CardContent>
    </Card>
  );
}

/** Status dot colored by event content (not time-based — avoids stale render). */
function StatusDot({ event }: { event: StreamEvent }): ReactElement {
  const status = typeof event.status === "string" ? event.status : undefined;
  let color = "bg-green-500";
  if (status === "degraded" || status === "failed") color = "bg-yellow-500";
  if (status === "down" || status === "error") color = "bg-red-500";

  return <span className={cn("h-2 w-2 shrink-0 rounded-full", color)} />;
}
