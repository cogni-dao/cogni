// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/work/coordination.server`
 * Purpose: App-layer facade for operator work-item execution sessions.
 * Scope: Binds human sessions and durable agent principals through the
 *   lightweight Postgres session port (exactly one claimant per session).
 * Invariants: DOLT_IS_SOURCE_OF_TRUTH, PORT_VIA_CONTAINER.
 * Side-effects: IO through injected ports and work-item facade.
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007
 * @internal
 */

import type { RequestPrincipal } from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { getContainer, getWorkItemSessionPort } from "@/bootstrap/container";
import type {
  WorkItemSessionClaimInput,
  WorkItemSessionHeartbeatInput,
  WorkItemSessionPrInput,
} from "@/contracts/work-item-sessions.v1.contract";
import {
  DEFAULT_SESSION_TTL_SECONDS,
  deadlineFromNow,
  nextActionForWorkItem,
  toWorkItemSessionDto,
} from "@/features/work-item-sessions/session-policy";

import {
  getWorkItem,
  patchWorkItem,
  patchWorkItemAsPrincipal,
} from "./items.server";

export class CoordinationWorkItemNotFoundError extends Error {
  constructor(id: string) {
    super(`Work item not found: ${id}`);
    this.name = "CoordinationWorkItemNotFoundError";
  }
}

export class WorkItemSessionNotFoundError extends Error {
  constructor(id: string) {
    super(`No active work-item session found for ${id}`);
    this.name = "WorkItemSessionNotFoundError";
  }
}

export class WorkItemSessionForbiddenError extends Error {
  constructor(id: string) {
    super(`Work item session for ${id} belongs to another user`);
    this.name = "WorkItemSessionForbiddenError";
  }
}

export class WorkItemSessionConflictError extends Error {
  constructor(id: string) {
    super(`Work item ${id} is claimed by another principal`);
    this.name = "WorkItemSessionConflictError";
  }
}

function requireSessionUser(user: SessionUser | null): SessionUser {
  if (!user) {
    throw new WorkItemSessionForbiddenError("unknown");
  }
  return user;
}

function ttlSeconds(input: { ttlSeconds?: number | undefined }): number {
  return input.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
}

function sessionNextAction(workItemId: string, statusUrl: string): string {
  return `Read ${statusUrl} for session status and GET /api/v1/work/items/${workItemId} for current lifecycle guidance before continuing.`;
}

async function requireWorkItem(id: string) {
  const workItem = await getWorkItem(id);
  if (!workItem) throw new CoordinationWorkItemNotFoundError(id);
  return workItem;
}

type AgentPrincipal = Extract<RequestPrincipal, { kind: "agent" }>;

/**
 * Claim through the PostgreSQL session port as the exact durable agent
 * principal (`claimed_by_principal_id`). The agent is never projected into a
 * users row; one active claim per item still holds, so another claimant's open
 * session raises WorkItemSessionConflictError.
 */
export async function claimWorkItemAsPrincipal(input: {
  readonly workItemId: string;
  readonly body: WorkItemSessionClaimInput;
  readonly principal: AgentPrincipal;
  readonly statusUrl: string;
  readonly now?: Date;
}) {
  const now = input.now ?? new Date();
  const workItem = await requireWorkItem(input.workItemId);
  const result = await getContainer().workItemSessions.claim({
    workItemId: input.workItemId,
    claimedByPrincipalId: input.principal.principalId,
    claimedByDisplayName: input.principal.displayName,
    deadlineAt: deadlineFromNow(now, ttlSeconds(input.body)),
    ...(input.body.lastCommand !== undefined && {
      lastCommand: input.body.lastCommand,
    }),
  });
  if (result.kind === "conflict") {
    throw new WorkItemSessionConflictError(input.workItemId);
  }

  return {
    claimed: true,
    conflict: false,
    session: toWorkItemSessionDto(result.session, now),
    nextAction: nextActionForWorkItem({
      workItem,
      session: result.session,
      now,
    }),
    statusUrl: input.statusUrl,
  };
}

/** Refresh the open session only when it is still held by this exact principal. */
export async function heartbeatWorkItemAsPrincipal(input: {
  readonly workItemId: string;
  readonly body: WorkItemSessionHeartbeatInput;
  readonly principal: AgentPrincipal;
  readonly statusUrl: string;
  readonly now?: Date;
}) {
  const now = input.now ?? new Date();
  const sessions = getWorkItemSessionPort();
  const session = await sessions.heartbeat({
    workItemId: input.workItemId,
    claimedByPrincipalId: input.principal.principalId,
    deadlineAt: deadlineFromNow(now, ttlSeconds(input.body)),
    ...(input.body.lastCommand !== undefined && {
      lastCommand: input.body.lastCommand,
    }),
  });

  if (!session) {
    const current = await sessions.getCurrent(input.workItemId);
    if (
      current &&
      current.claimedByPrincipalId !== input.principal.principalId
    ) {
      throw new WorkItemSessionForbiddenError(input.workItemId);
    }
    throw new WorkItemSessionNotFoundError(input.workItemId);
  }

  return {
    session: toWorkItemSessionDto(session, now),
    nextAction: sessionNextAction(session.workItemId, input.statusUrl),
    statusUrl: input.statusUrl,
  };
}

export async function claimWorkItemSession(input: {
  readonly workItemId: string;
  readonly body: WorkItemSessionClaimInput;
  readonly sessionUser: SessionUser | null;
  readonly statusUrl: string;
  readonly now?: Date;
}) {
  const sessionUser = requireSessionUser(input.sessionUser);
  const now = input.now ?? new Date();
  const workItem = await requireWorkItem(input.workItemId);
  const result = await getContainer().workItemSessions.claim({
    workItemId: input.workItemId,
    claimedByUserId: sessionUser.id,
    claimedByDisplayName: sessionUser.displayName,
    deadlineAt: deadlineFromNow(now, ttlSeconds(input.body)),
    ...(input.body.lastCommand !== undefined && {
      lastCommand: input.body.lastCommand,
    }),
  });
  const conflict = result.kind === "conflict";

  return {
    claimed: result.kind === "claimed",
    conflict,
    session: toWorkItemSessionDto(result.session, now),
    nextAction: nextActionForWorkItem({
      workItem,
      session: result.session,
      now,
      conflict,
    }),
    statusUrl: input.statusUrl,
  };
}

export async function heartbeatWorkItemSession(input: {
  readonly workItemId: string;
  readonly body: WorkItemSessionHeartbeatInput;
  readonly sessionUser: SessionUser | null;
  readonly statusUrl: string;
  readonly now?: Date;
}) {
  const sessionUser = requireSessionUser(input.sessionUser);
  const now = input.now ?? new Date();
  const sessions = getWorkItemSessionPort();
  const session = await sessions.heartbeat({
    workItemId: input.workItemId,
    claimedByUserId: sessionUser.id,
    deadlineAt: deadlineFromNow(now, ttlSeconds(input.body)),
    ...(input.body.lastCommand !== undefined && {
      lastCommand: input.body.lastCommand,
    }),
  });

  if (!session) {
    const current = await sessions.getCurrent(input.workItemId);
    if (current && current.claimedByUserId !== sessionUser.id) {
      throw new WorkItemSessionForbiddenError(input.workItemId);
    }
    throw new WorkItemSessionNotFoundError(input.workItemId);
  }

  return {
    session: toWorkItemSessionDto(session, now),
    nextAction: sessionNextAction(session.workItemId, input.statusUrl),
    statusUrl: input.statusUrl,
  };
}

export async function linkWorkItemSessionPr(input: {
  readonly workItemId: string;
  readonly body: WorkItemSessionPrInput;
  readonly sessionUser: SessionUser | null;
  readonly statusUrl: string;
  readonly now?: Date;
}) {
  const sessionUser = requireSessionUser(input.sessionUser);
  const now = input.now ?? new Date();
  await requireWorkItem(input.workItemId);
  const session = await getContainer().workItemSessions.linkPr({
    workItemId: input.workItemId,
    claimedByUserId: sessionUser.id,
    ...(input.body.branch !== undefined && { branch: input.body.branch }),
    ...(input.body.prNumber !== undefined && { prNumber: input.body.prNumber }),
  });

  if (!session) {
    const current = await getContainer().workItemSessions.getCurrent(
      input.workItemId
    );
    if (current && current.claimedByUserId !== sessionUser.id) {
      throw new WorkItemSessionForbiddenError(input.workItemId);
    }
    throw new WorkItemSessionNotFoundError(input.workItemId);
  }

  const patchedWorkItem = await patchWorkItem(
    {
      id: input.workItemId,
      set: {
        ...(input.body.branch !== undefined && { branch: input.body.branch }),
        ...(input.body.prNumber !== undefined && {
          pr: String(input.body.prNumber),
        }),
      },
    },
    { id: sessionUser.id, displayName: sessionUser.displayName }
  );

  return {
    session: toWorkItemSessionDto(session, now),
    nextAction: nextActionForWorkItem({
      workItem: patchedWorkItem,
      session,
      now,
    }),
    statusUrl: input.statusUrl,
  };
}

/**
 * Link branch/PR metadata to the open session held by this exact durable agent
 * principal, then patch the durable work item with the same principal so the
 * PR link stays AI-attributed (`agent:<node>/<actorId>`).
 */
export async function linkWorkItemSessionPrAsPrincipal(input: {
  readonly workItemId: string;
  readonly body: WorkItemSessionPrInput;
  readonly principal: AgentPrincipal;
  readonly statusUrl: string;
  readonly now?: Date;
}) {
  const now = input.now ?? new Date();
  await requireWorkItem(input.workItemId);
  const sessions = getContainer().workItemSessions;
  const session = await sessions.linkPr({
    workItemId: input.workItemId,
    claimedByPrincipalId: input.principal.principalId,
    ...(input.body.branch !== undefined && { branch: input.body.branch }),
    ...(input.body.prNumber !== undefined && { prNumber: input.body.prNumber }),
  });

  if (!session) {
    const current = await sessions.getCurrent(input.workItemId);
    if (
      current &&
      current.claimedByPrincipalId !== input.principal.principalId
    ) {
      throw new WorkItemSessionForbiddenError(input.workItemId);
    }
    throw new WorkItemSessionNotFoundError(input.workItemId);
  }

  const patchedWorkItem = await patchWorkItemAsPrincipal(
    {
      id: input.workItemId,
      set: {
        ...(input.body.branch !== undefined && { branch: input.body.branch }),
        ...(input.body.prNumber !== undefined && {
          pr: String(input.body.prNumber),
        }),
      },
    },
    input.principal.principalId
  );

  return {
    session: toWorkItemSessionDto(session, now),
    nextAction: nextActionForWorkItem({
      workItem: patchedWorkItem,
      session,
      now,
    }),
    statusUrl: input.statusUrl,
  };
}

export async function getWorkItemCoordination(input: {
  readonly workItemId: string;
  readonly statusUrl: string;
  readonly now?: Date;
}) {
  const now = input.now ?? new Date();
  const session = await getWorkItemSessionPort().getCurrent(input.workItemId);
  if (session) {
    return {
      workItemId: input.workItemId,
      session: toWorkItemSessionDto(session, now),
      nextAction: sessionNextAction(session.workItemId, input.statusUrl),
      statusUrl: input.statusUrl,
    };
  }
  const workItem = await requireWorkItem(input.workItemId);

  return {
    workItemId: input.workItemId,
    session: null,
    nextAction: nextActionForWorkItem({ workItem, session, now }),
    statusUrl: input.statusUrl,
  };
}
