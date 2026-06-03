// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/work/coordination.server`
 * Purpose: App-layer facade for operator work-item execution sessions.
 * Scope: Validates Doltgres/markdown work-item existence, binds session user
 *   identity, delegates persistence through the session port, and maps DTOs.
 * Invariants: DOLT_IS_SOURCE_OF_TRUTH, PORT_VIA_CONTAINER.
 * Side-effects: IO through injected ports and work-item facade.
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007
 * @internal
 */

import type { SessionUser } from "@cogni/node-shared";
import { getContainer } from "@/bootstrap/container";
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

import { getWorkItem, patchWorkItem } from "./items.server";

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

function requireSessionUser(user: SessionUser | null): SessionUser {
  if (!user) {
    throw new WorkItemSessionForbiddenError("unknown");
  }
  return user;
}

function ttlSeconds(input: { ttlSeconds?: number | undefined }): number {
  return input.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
}

async function requireWorkItem(id: string) {
  const workItem = await getWorkItem(id);
  if (!workItem) throw new CoordinationWorkItemNotFoundError(id);
  return workItem;
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
  const workItem = await requireWorkItem(input.workItemId);
  const session = await getContainer().workItemSessions.heartbeat({
    workItemId: input.workItemId,
    claimedByUserId: sessionUser.id,
    deadlineAt: deadlineFromNow(now, ttlSeconds(input.body)),
    ...(input.body.lastCommand !== undefined && {
      lastCommand: input.body.lastCommand,
    }),
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

  return {
    session: toWorkItemSessionDto(session, now),
    nextAction: nextActionForWorkItem({ workItem, session, now }),
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

export class WorkItemSessionPrMismatchError extends Error {
  constructor(id: string, prNumber: number) {
    super(`PR #${prNumber} is not linked to work item ${id}`);
    this.name = "WorkItemSessionPrMismatchError";
  }
}

/**
 * Assert that `prNumber` is the PR currently linked to `workItemId`'s session,
 * and that the caller owns that session. Forge-resistant gate for privileged
 * VCS actions (e.g. fork-check approval): the agent proved ownership when it
 * linked the PR via /pr under its own Bearer principal — we re-check both here.
 */
export async function assertPrLinkedBySession(input: {
  readonly workItemId: string;
  readonly prNumber: number;
  readonly sessionUser: SessionUser | null;
}): Promise<void> {
  const sessionUser = requireSessionUser(input.sessionUser);
  await requireWorkItem(input.workItemId);
  const session = await getContainer().workItemSessions.getCurrent(
    input.workItemId
  );
  if (!session) {
    throw new WorkItemSessionNotFoundError(input.workItemId);
  }
  if (session.claimedByUserId !== sessionUser.id) {
    throw new WorkItemSessionForbiddenError(input.workItemId);
  }
  if (session.prNumber !== input.prNumber) {
    throw new WorkItemSessionPrMismatchError(input.workItemId, input.prNumber);
  }
}

export async function getWorkItemCoordination(input: {
  readonly workItemId: string;
  readonly statusUrl: string;
  readonly now?: Date;
}) {
  const now = input.now ?? new Date();
  const workItem = await requireWorkItem(input.workItemId);
  const session = await getContainer().workItemSessions.getCurrent(
    input.workItemId
  );

  return {
    workItemId: input.workItemId,
    session: session ? toWorkItemSessionDto(session, now) : null,
    nextAction: nextActionForWorkItem({ workItem, session, now }),
    statusUrl: input.statusUrl,
  };
}
