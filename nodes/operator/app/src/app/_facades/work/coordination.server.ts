// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/work/coordination.server`
 * Purpose: App-layer facade for operator work-item execution sessions.
 * Scope: Binds human sessions through the lightweight Postgres session port
 *   and durable agent principals through the canonical Dolt work-item store.
 * Invariants: DOLT_IS_SOURCE_OF_TRUTH, PORT_VIA_CONTAINER.
 * Side-effects: IO through injected ports and work-item facade.
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007
 * @internal
 */

import { randomUUID } from "node:crypto";
import type { RequestPrincipal } from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { toWorkItemId } from "@cogni/work-items";
import { getContainer, getWorkItemSessionPort } from "@/bootstrap/container";
import type {
  WorkItemSessionClaimInput,
  WorkItemSessionDto,
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

const DURABLE_PRINCIPAL_CLAIM_TTL_SECONDS = 300;

type AgentPrincipal = Extract<RequestPrincipal, { kind: "agent" }>;
type DurableClaimWorkItem = {
  readonly id: string;
  readonly status: string;
  readonly claimedAt?: string;
  readonly lastCommand?: string;
  readonly branch?: string;
  readonly pr?: string;
};

function durablePrincipalSessionDto(input: {
  readonly workItem: DurableClaimWorkItem;
  readonly principal: AgentPrincipal;
  readonly runId: string;
  readonly now: Date;
  readonly heartbeat: boolean;
}): WorkItemSessionDto {
  const claimedAt = input.workItem.claimedAt ?? input.now.toISOString();
  return {
    coordinationId: input.runId,
    workItemId: input.workItem.id,
    status: "active",
    // Compatibility field for existing clients. This is the exact principal,
    // not a users.id projection, and is never persisted to claimed_by_user_id.
    claimedByUserId: input.principal.principalId,
    claimedByPrincipalId: input.principal.principalId,
    claimedByDisplayName: input.principal.displayName,
    claimedAt,
    lastHeartbeatAt: input.heartbeat ? input.now.toISOString() : null,
    deadlineAt: new Date(
      input.now.getTime() + DURABLE_PRINCIPAL_CLAIM_TTL_SECONDS * 1000
    ).toISOString(),
    closedAt: null,
    lastCommand: input.workItem.lastCommand ?? null,
    branch: input.workItem.branch ?? null,
    prNumber:
      input.workItem.pr && /^\d+$/.test(input.workItem.pr)
        ? Number(input.workItem.pr)
        : null,
  };
}

function mapDurablePrincipalStoreError(error: unknown, id: string): never {
  const name = (error as Error)?.name;
  const message = (error as Error)?.message ?? "";
  if (name === "WorkItemLeaseConflictError") {
    throw new WorkItemSessionConflictError(id);
  }
  if (name === "WorkItemAuthorizationError") {
    throw new WorkItemSessionForbiddenError(id);
  }
  if (message.includes("Work item not found")) {
    throw new CoordinationWorkItemNotFoundError(id);
  }
  throw error;
}

/**
 * Claim the canonical Dolt work item directly as a durable agent principal.
 * This deliberately bypasses the legacy Postgres user-FK session table.
 */
export async function claimWorkItemAsPrincipal(input: {
  readonly workItemId: string;
  readonly body: WorkItemSessionClaimInput;
  readonly principal: AgentPrincipal;
  readonly statusUrl: string;
  readonly now?: Date;
}) {
  const now = input.now ?? new Date();
  const runId = randomUUID();
  try {
    const workItem = await getContainer().doltgresWorkItems.claim({
      id: toWorkItemId(input.workItemId),
      runId,
      command: input.body.lastCommand ?? "claim",
      principalId: input.principal.principalId,
    });
    return {
      claimed: true,
      conflict: false,
      session: durablePrincipalSessionDto({
        workItem,
        principal: input.principal,
        runId,
        now,
        heartbeat: false,
      }),
      nextAction: `Continue ${workItem.status} for ${workItem.id}; heartbeat the durable principal claim while working.`,
      statusUrl: input.statusUrl,
    };
  } catch (error) {
    return mapDurablePrincipalStoreError(error, input.workItemId);
  }
}

/** Refresh the active Dolt lease only when both run and principal still match. */
export async function heartbeatWorkItemAsPrincipal(input: {
  readonly workItemId: string;
  readonly body: WorkItemSessionHeartbeatInput;
  readonly principal: AgentPrincipal;
  readonly statusUrl: string;
  readonly now?: Date;
}) {
  const now = input.now ?? new Date();
  try {
    const current = await getContainer().doltgresWorkItems.get(
      toWorkItemId(input.workItemId)
    );
    if (!current) throw new CoordinationWorkItemNotFoundError(input.workItemId);
    if (!current.claimedByRun) {
      throw new WorkItemSessionNotFoundError(input.workItemId);
    }
    const workItem = await getContainer().doltgresWorkItems.heartbeat({
      id: toWorkItemId(input.workItemId),
      runId: current.claimedByRun,
      ...(input.body.lastCommand !== undefined && {
        command: input.body.lastCommand,
      }),
      principalId: input.principal.principalId,
    });
    return {
      session: durablePrincipalSessionDto({
        workItem,
        principal: input.principal,
        runId: current.claimedByRun,
        now,
        heartbeat: true,
      }),
      nextAction: `Continue ${workItem.status} for ${workItem.id}; the durable principal claim is active.`,
      statusUrl: input.statusUrl,
    };
  } catch (error) {
    if (
      error instanceof CoordinationWorkItemNotFoundError ||
      error instanceof WorkItemSessionNotFoundError
    ) {
      throw error;
    }
    return mapDurablePrincipalStoreError(error, input.workItemId);
  }
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
