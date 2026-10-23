// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/work-item-sessions/session-policy`
 * Purpose: Pure policy for operator work-item coordination sessions.
 * Scope: Deadline math, DTO mapping, and next-action text. Does not perform
 *   persistence, auth, or HTTP translation.
 * Invariants: DOLT_IS_SOURCE_OF_TRUTH — work item status remains the lifecycle
 *   input; session state only guides active execution.
 *   LIFECYCLE_ORDER_FROM_HUB — next-action text orders fresh review (while CI
 *   runs) → flight → validate → closeout operator merge (hub
 *   dev-manager-contract). SCORECARD_IS_VALIDATION — the passing
 *   /validate-candidate scorecard on the PR for the head SHA is the only
 *   validation signal; no work-item flag gates or branches the text.
 * Side-effects: none
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007, task.5292
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

/** The single claimant id of a session (EXACTLY_ONE_CLAIMANT). */
export function sessionClaimantId(session: WorkItemSessionRecord): string {
  const id = session.claimedByUserId ?? session.claimedByPrincipalId;
  if (!id) throw new Error(`work item session ${session.id} has no claimant`);
  return id;
}

export function toWorkItemSessionDto(
  session: WorkItemSessionRecord,
  now: Date
): WorkItemSessionDto {
  return {
    coordinationId: session.id,
    workItemId: session.workItemId,
    status: effectiveSessionStatus(session, now),
    // @deprecated compatibility field for existing clients: the human user id,
    // or the exact durable agent principal id (never an agent projected into
    // users.id). New clients read claimedByPrincipalId for agents; remove after
    // clients migrate.
    claimedByUserId: sessionClaimantId(session),
    ...(session.claimedByPrincipalId !== null && {
      claimedByPrincipalId: session.claimedByPrincipalId,
    }),
    claimedByDisplayName: session.claimedByDisplayName,
    claimedAt: session.claimedAt.toISOString(),
    lastHeartbeatAt: session.lastHeartbeatAt?.toISOString() ?? null,
    deadlineAt: session.deadlineAt.toISOString(),
    closedAt: session.closedAt?.toISOString() ?? null,
    lastCommand: session.lastCommand,
    branch: session.branch,
    prNumber: session.prNumber,
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
    const owner = session.claimedByDisplayName ?? sessionClaimantId(session);
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
      return `Continue /implement for ${workItem.id}; when ${prTag} carries Evidence and Merge Danger, set needs_merge so a fresh /review-implementation starts while CI runs.`;
    case "needs_merge":
      return `Start a fresh /review-implementation of ${prTag} (${workItem.id}) now, while CI runs; the implementer never reviews its own work. When APPROVE and required CI are green at one head SHA, flight that SHA (POST /api/v1/vcs/flight) and run /validate-candidate, which posts the scorecard on the PR; when it passes, PATCH status needs_closeout so /closeout merges through POST /api/v1/vcs/merge. REQUEST CHANGES returns ${workItem.id} to needs_implement.`;
    case "needs_closeout":
      return `Run /closeout for ${workItem.id}: confirm CI, the /review-implementation APPROVE and the passing /validate-candidate scorecard name one head SHA on ${prTag} (else return to needs_merge), then POST /api/v1/vcs/merge and set done after it merges.`;
    case "done":
      return `${workItem.id} is done. Preview follows main; production promote waits for a human to look at user-facing changes.`;
    case "blocked":
      return `${workItem.id} is blocked. Resolve blocked_by before continuing.`;
    case "cancelled":
      return `${workItem.id} is cancelled. Close this session if it is still active.`;
    default:
      return `Run the lifecycle command for ${workItem.status} on ${workItem.id}.`;
  }
}
