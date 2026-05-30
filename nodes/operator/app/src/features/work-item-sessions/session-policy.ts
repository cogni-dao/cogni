// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/work-item-sessions/session-policy`
 * Purpose: Pure policy for operator work-item coordination sessions.
 * Scope: Deadline math, DTO mapping, and next-action text. Does not perform
 *   persistence, auth, or HTTP translation.
 * Invariants: DOLT_IS_SOURCE_OF_TRUTH — work item status remains the lifecycle
 *   input; session state only guides active execution.
 * Side-effects: none
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007
 * @public
 */

import type { WorkItemDto } from "@cogni/node-contracts";

import type { WorkItemSessionDto } from "@/contracts/work-item-sessions.v1.contract";
import type { WorkItemSessionRecord, WorkItemSessionStatus } from "@/ports";

export const DEFAULT_SESSION_TTL_SECONDS = 30 * 60;

export function deadlineFromNow(now: Date, ttlSeconds: number): Date {
  return new Date(now.getTime() + ttlSeconds * 1000);
}

export function effectiveSessionStatus(
  session: WorkItemSessionRecord,
  now: Date
): WorkItemSessionStatus {
  if (session.status !== "active") return session.status;
  return session.deadlineAt.getTime() < now.getTime() ? "idle" : "active";
}

export function toWorkItemSessionDto(
  session: WorkItemSessionRecord,
  now: Date
): WorkItemSessionDto {
  return {
    coordinationId: session.id,
    workItemId: session.workItemId,
    status: effectiveSessionStatus(session, now),
    claimedByUserId: session.claimedByUserId,
    claimedByDisplayName: session.claimedByDisplayName,
    claimedAt: session.claimedAt.toISOString(),
    lastHeartbeatAt: session.lastHeartbeatAt?.toISOString() ?? null,
    deadlineAt: session.deadlineAt.toISOString(),
    closedAt: session.closedAt?.toISOString() ?? null,
    lastCommand: session.lastCommand,
    branch: session.branch,
    prNumber: session.prNumber,
    repoFullName: session.repoFullName,
  };
}

export function nextActionForWorkItem(input: {
  readonly workItem: WorkItemDto | null;
  readonly session: WorkItemSessionRecord | null;
  readonly now: Date;
  readonly conflict?: boolean;
}): string {
  const { workItem, session, now, conflict } = input;

  if (!workItem) {
    return "Work item not found. Check the id and retry.";
  }
  if (!session) {
    return `Claim ${workItem.id} before starting ${workItem.status}.`;
  }

  const status = effectiveSessionStatus(session, now);
  if (conflict) {
    const owner = session.claimedByDisplayName ?? session.claimedByUserId;
    return `${workItem.id} is already claimed by ${owner}. Poll coordination status or wait until the claim is released.`;
  }
  if (status === "idle") {
    return `Heartbeat expired for ${workItem.id}. POST /heartbeat to keep the claim before continuing.`;
  }

  if (!session.prNumber && !workItem.pr) {
    return `Continue ${workItem.status} for ${workItem.id}, then link the branch or PR with POST /pr.`;
  }

  const prRef = session.prNumber ?? workItem.pr ?? null;
  const prTag = prRef ? `PR #${prRef}` : "the linked PR";

  switch (workItem.status) {
    case "needs_implement":
      return `Continue /implement for ${workItem.id}; heartbeat until code is ready for closeout.`;
    case "needs_closeout":
      return `Run /closeout for ${workItem.id}; keep the linked PR current.`;
    case "needs_merge":
      if (!workItem.deployVerified) {
        return `Run /validate-candidate for ${prTag} (${workItem.id}); post the scorecard and flip deployVerified before /review-implementation.`;
      }
      return `Run /review-implementation for ${workItem.id}; use the linked PR as review context.`;
    case "done":
      if (!workItem.deployVerified) {
        return `${workItem.id} merged but deployVerified is false. Run /validate-candidate against ${prTag} and post the scorecard to close the loop.`;
      }
      return `${workItem.id} is done. No active implementation action is required.`;
    case "blocked":
      return `${workItem.id} is blocked. Resolve blocked_by before continuing.`;
    case "cancelled":
      return `${workItem.id} is cancelled. Close this session if it is still active.`;
    default:
      return `Run the lifecycle command for ${workItem.status} on ${workItem.id}.`;
  }
}
