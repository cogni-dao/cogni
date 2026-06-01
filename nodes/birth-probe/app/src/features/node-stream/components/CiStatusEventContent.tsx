// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-stream/components/CiStatusEventContent`
 * Purpose: Renders CI status event details — branch, conclusion, workflow name, link.
 * Scope: Presentational only. Does not fetch data.
 * Invariants:
 *   - PRESENTATIONAL_CARDS: Typed event as props, no hooks
 * Side-effects: none
 * Links: @cogni/node-streams CiStatusEvent
 * @public
 */

import type { ReactElement } from "react";
import { Badge } from "@/components";

interface CiStatusEventData {
  branch: string;
  conclusion: string | null;
  workflowName: string;
  runUrl: string;
  commitSha: string;
  commitMessage: string;
}

export function CiStatusEventContent({
  event,
}: {
  event: CiStatusEventData;
}): ReactElement {
  const conclusion = event.conclusion ?? "in_progress";
  const intent =
    conclusion === "success"
      ? ("default" as const)
      : conclusion === "failure"
        ? ("destructive" as const)
        : ("secondary" as const);

  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-center gap-2">
        <Badge intent={intent} size="sm">
          {conclusion}
        </Badge>
        <span className="font-mono text-muted-foreground text-xs">
          {event.branch}
        </span>
        <span className="text-muted-foreground">{event.workflowName}</span>
      </div>
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span className="font-mono">{event.commitSha.slice(0, 7)}</span>
        <span className="truncate">{event.commitMessage}</span>
        <a
          href={event.runUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto shrink-0 text-primary hover:underline"
        >
          View run
        </a>
      </div>
    </div>
  );
}
