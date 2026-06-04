// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-stream/components/HealthEventContent`
 * Purpose: Renders health probe event details — status pill, latency, HTTP code.
 * Scope: Presentational only. Does not fetch data.
 * Invariants:
 *   - PRESENTATIONAL_CARDS: Typed event as props, no hooks
 * Side-effects: none
 * Links: @cogni/node-streams HealthEvent
 * @public
 */

import type { ReactElement } from "react";
import { Badge } from "@/components";

interface HealthEventData {
  status: "healthy" | "degraded" | "down";
  environment: string;
  httpStatus: number | null;
  latencyMs: number | null;
  url: string;
}

const STATUS_INTENT = {
  healthy: "default",
  degraded: "secondary",
  down: "destructive",
} as const;

export function HealthEventContent({
  event,
}: {
  event: HealthEventData;
}): ReactElement {
  return (
    <div className="flex items-center gap-3 text-sm">
      <Badge intent={STATUS_INTENT[event.status]} size="sm">
        {event.status}
      </Badge>
      <span className="text-muted-foreground">{event.environment}</span>
      {event.latencyMs != null && (
        <span className="text-muted-foreground">{event.latencyMs}ms</span>
      )}
      {event.httpStatus != null && (
        <span className="text-muted-foreground">HTTP {event.httpStatus}</span>
      )}
    </div>
  );
}
