// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-stream/components/DeployEventContent`
 * Purpose: Renders deploy lifecycle event details — environment, status, actor, commit SHA.
 * Scope: Presentational only. Does not fetch data.
 * Invariants:
 *   - PRESENTATIONAL_CARDS: Typed event as props, no hooks
 * Side-effects: none
 * Links: @cogni/node-streams DeployEvent
 * @public
 */

import type { ReactElement } from "react";
import { Badge } from "@/components";

interface DeployEventData {
  environment: string;
  status: "started" | "success" | "failed";
  actor: string;
  commitSha: string;
}

const STATUS_INTENT = {
  started: "secondary",
  success: "default",
  failed: "destructive",
} as const;

export function DeployEventContent({
  event,
}: {
  event: DeployEventData;
}): ReactElement {
  return (
    <div className="flex items-center gap-3 text-sm">
      <Badge intent={STATUS_INTENT[event.status]} size="sm">
        {event.status}
      </Badge>
      <span className="text-muted-foreground">{event.environment}</span>
      <span className="font-mono text-muted-foreground text-xs">
        {event.commitSha.slice(0, 7)}
      </span>
      <span className="text-muted-foreground">{event.actor}</span>
    </div>
  );
}
