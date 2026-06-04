// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-stream/components/ProcessHealthEventContent`
 * Purpose: Renders process health metrics — heap, RSS, event loop delay, uptime.
 * Scope: Presentational only. Does not fetch data.
 * Invariants:
 *   - PRESENTATIONAL_CARDS: Typed event as props, no hooks
 * Side-effects: none
 * Links: @cogni/node-streams ProcessHealthEvent
 * @public
 */

import type { ReactElement } from "react";
import { Badge } from "@/components";

interface ProcessHealthData {
  heapUsedMb: number;
  rssMb: number;
  uptimeSeconds: number;
  eventLoopDelayMs: number;
  environment: string;
}

function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export function ProcessHealthEventContent({
  event,
}: {
  event: ProcessHealthData;
}): ReactElement {
  return (
    <div className="flex items-center gap-3 text-sm">
      <Badge intent="default" size="sm">
        {event.environment}
      </Badge>
      <span className="text-muted-foreground">Heap {event.heapUsedMb}MB</span>
      <span className="text-muted-foreground">RSS {event.rssMb}MB</span>
      <span className="text-muted-foreground">
        EL {event.eventLoopDelayMs}ms
      </span>
      <span className="text-muted-foreground">
        Up {formatUptime(event.uptimeSeconds)}
      </span>
    </div>
  );
}
