// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/artifacts/_respond`
 * Purpose: The one terminal log event and response of every artifacts route (the list, the write and one artifact).
 * Scope: Maps a `@cogni/work-items` `ArtifactResult` to its event name and a JSON response. No reads, no writes.
 * Invariants: one terminal log event per call (codes and counts only); a failed call carries its `errorName` on that line.
 * Side-effects: IO (log line)
 * Links: @cogni-dao/work-items recordWorkItemArtifact, listWorkItemArtifacts, readWorkItemArtifact
 * @internal
 */

import type { ArtifactResult } from "@cogni/work-items";
import { NextResponse } from "next/server";

import { EVENT_NAMES, logEvent } from "@/shared/observability";

const EVENT_BY_LOG = {
  "work.items.artifact_recorded": EVENT_NAMES.WORK_ITEMS_ARTIFACT_RECORDED,
  "work.items.artifact_refused": EVENT_NAMES.WORK_ITEMS_ARTIFACT_REFUSED,
  "work.items.artifacts_read": EVENT_NAMES.WORK_ITEMS_ARTIFACTS_READ,
} as const;

/** One terminal log event per call, then the response. A failed call carries its `errorName` on that same line. */
export function respond(
  ctx: {
    readonly log: Parameters<typeof logEvent>[0];
    readonly reqId: string;
    readonly routeId: string;
  },
  startedAt: number,
  { status, body, log }: ArtifactResult
): NextResponse {
  const { event, errorName, ...fields } = log;
  logEvent(ctx.log, EVENT_BY_LOG[event], {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    ...fields,
    ...(errorName !== undefined ? { errorName } : {}),
    durationMs: Date.now() - startedAt,
  });
  return NextResponse.json(body, { status });
}
