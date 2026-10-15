// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/_session-log`
 * Purpose: Emit one feature-specific terminal event for a work-item session mutation.
 * Scope: Request-scoped structured logging only; no coordination or persistence behavior.
 * Invariants: ONE_TERMINAL_EVENT, REGISTRY_EVENT_NAME, NO_PRINCIPAL_OR_PAYLOAD_LOGGING.
 * Side-effects: IO (structured log line).
 * Links: bug.5136, knowledge/node-observability-finish-pass
 * @internal
 */

import { EVENT_NAMES, type RequestContext } from "@/shared/observability";

export interface WorkItemSessionLogFields {
  readonly operation: "claim" | "heartbeat" | "link_pr";
  readonly outcome: "success" | "error";
  readonly status: number;
  readonly result?: "claimed" | "conflict" | undefined;
  readonly claimKind?: "fresh" | "refreshed" | "reclaimed" | undefined;
  readonly errorCode?:
    | "auth_required"
    | "validation_error"
    | "work_item_not_found"
    | "session_owned_by_other"
    | "session_expired_or_missing"
    | "internal_error"
    | undefined;
}

export function logWorkItemSessionComplete(
  ctx: RequestContext,
  startedAt: number,
  fields: WorkItemSessionLogFields
): void {
  const payload = {
    event: EVENT_NAMES.WORK_ITEM_SESSION_COMPLETE,
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    durationMs: Math.round(performance.now() - startedAt),
    ...fields,
  };
  const level =
    fields.outcome === "success"
      ? "info"
      : fields.status >= 500
        ? "error"
        : "warn";
  ctx.log[level](payload, EVENT_NAMES.WORK_ITEM_SESSION_COMPLETE);
}
