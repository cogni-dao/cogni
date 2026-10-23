// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db/work-item-session`
 * Purpose: Drizzle adapter for operator work-item execution sessions.
 * Scope: Persistence only. Does not validate work-item existence, enforce
 *   route auth, derive next actions, or call GitHub.
 * Invariants: ONE_ACTIVE_CLAIM_DB_ENFORCED, SERVICE_DB_SHARED_COORDINATION,
 *   EXACTLY_ONE_CLAIMANT (human user id xor durable agent principal id; DB CHECK backs it).
 * Side-effects: IO (Postgres via injected Drizzle database).
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";

import type {
  ClaimWorkItemSessionResult,
  WorkItemSessionClaimant,
  WorkItemSessionPort,
  WorkItemSessionRecord,
} from "@/ports";
import { workItemSessions } from "@/shared/db/work-item-sessions";

const OPEN_SESSION_STATUSES = ["active", "idle"] as const;

function toRecord(
  row: typeof workItemSessions.$inferSelect
): WorkItemSessionRecord {
  return {
    id: row.id,
    workItemId: row.workItemId,
    claimedByUserId: row.claimedByUserId,
    claimedByPrincipalId: row.claimedByPrincipalId,
    claimedByDisplayName: row.claimedByDisplayName,
    status: row.status as WorkItemSessionRecord["status"],
    claimedAt: row.claimedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    deadlineAt: row.deadlineAt,
    closedAt: row.closedAt,
    lastCommand: row.lastCommand,
    branch: row.branch,
    prNumber: row.prNumber,
  };
}

function claimantColumns(claimant: WorkItemSessionClaimant): {
  readonly claimedByUserId: string | null;
  readonly claimedByPrincipalId: string | null;
} {
  return claimant.claimedByUserId !== undefined
    ? { claimedByUserId: claimant.claimedByUserId, claimedByPrincipalId: null }
    : {
        claimedByUserId: null,
        claimedByPrincipalId: claimant.claimedByPrincipalId,
      };
}

function claimantWhere(claimant: WorkItemSessionClaimant): SQL {
  return claimant.claimedByUserId !== undefined
    ? eq(workItemSessions.claimedByUserId, claimant.claimedByUserId)
    : eq(workItemSessions.claimedByPrincipalId, claimant.claimedByPrincipalId);
}

function isSameClaimant(
  session: WorkItemSessionRecord,
  claimant: WorkItemSessionClaimant
): boolean {
  const columns = claimantColumns(claimant);
  return (
    session.claimedByUserId === columns.claimedByUserId &&
    session.claimedByPrincipalId === columns.claimedByPrincipalId
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

export class DrizzleWorkItemSessionAdapter implements WorkItemSessionPort {
  constructor(private readonly db: Database) {}

  async claim(
    input: WorkItemSessionClaimant & {
      readonly workItemId: string;
      readonly claimedByDisplayName: string | null;
      readonly deadlineAt: Date;
      readonly lastCommand?: string;
    }
  ): Promise<ClaimWorkItemSessionResult> {
    const existing = await this.getOpen(input.workItemId);
    if (existing) {
      if (!isSameClaimant(existing, input)) {
        return { kind: "conflict", session: existing };
      }
      return {
        kind: "claimed",
        session: await this.refreshExistingClaim(existing.id, input),
      };
    }

    try {
      const [inserted] = await this.db
        .insert(workItemSessions)
        .values({
          workItemId: input.workItemId,
          ...claimantColumns(input),
          claimedByDisplayName: input.claimedByDisplayName,
          deadlineAt: input.deadlineAt,
          lastCommand: input.lastCommand,
        })
        .returning();

      if (!inserted)
        throw new Error("work item session insert returned no row");
      return { kind: "claimed", session: toRecord(inserted) };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const conflicted = await this.getOpen(input.workItemId);
      if (!conflicted) throw error;
      if (isSameClaimant(conflicted, input)) {
        return {
          kind: "claimed",
          session: await this.refreshExistingClaim(conflicted.id, input),
        };
      }
      return { kind: "conflict", session: conflicted };
    }
  }

  async heartbeat(
    input: WorkItemSessionClaimant & {
      readonly workItemId: string;
      readonly deadlineAt: Date;
      readonly lastCommand?: string;
    }
  ): Promise<WorkItemSessionRecord | null> {
    const [updated] = await this.db
      .update(workItemSessions)
      .set({
        status: "active",
        lastHeartbeatAt: new Date(),
        deadlineAt: input.deadlineAt,
        ...(input.lastCommand !== undefined && {
          lastCommand: input.lastCommand,
        }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workItemSessions.workItemId, input.workItemId),
          claimantWhere(input),
          inArray(workItemSessions.status, [...OPEN_SESSION_STATUSES])
        )
      )
      .returning();

    return updated ? toRecord(updated) : null;
  }

  async linkPr(
    input: WorkItemSessionClaimant & {
      readonly workItemId: string;
      readonly branch?: string;
      readonly prNumber?: number;
    }
  ): Promise<WorkItemSessionRecord | null> {
    const [updated] = await this.db
      .update(workItemSessions)
      .set({
        ...(input.branch !== undefined && { branch: input.branch }),
        ...(input.prNumber !== undefined && { prNumber: input.prNumber }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workItemSessions.workItemId, input.workItemId),
          claimantWhere(input),
          inArray(workItemSessions.status, [...OPEN_SESSION_STATUSES])
        )
      )
      .returning();

    return updated ? toRecord(updated) : null;
  }

  async getCurrent(workItemId: string): Promise<WorkItemSessionRecord | null> {
    const open = await this.getOpen(workItemId);
    if (open) return open;

    const [latest] = await this.db
      .select()
      .from(workItemSessions)
      .where(eq(workItemSessions.workItemId, workItemId))
      .orderBy(desc(workItemSessions.claimedAt))
      .limit(1);

    return latest ? toRecord(latest) : null;
  }

  private async getOpen(
    workItemId: string
  ): Promise<WorkItemSessionRecord | null> {
    const [row] = await this.db
      .select()
      .from(workItemSessions)
      .where(
        and(
          eq(workItemSessions.workItemId, workItemId),
          inArray(workItemSessions.status, [...OPEN_SESSION_STATUSES])
        )
      )
      .orderBy(desc(workItemSessions.claimedAt))
      .limit(1);

    return row ? toRecord(row) : null;
  }

  private async refreshExistingClaim(
    id: string,
    input: {
      readonly deadlineAt: Date;
      readonly lastCommand?: string;
    }
  ): Promise<WorkItemSessionRecord> {
    const [updated] = await this.db
      .update(workItemSessions)
      .set({
        status: "active",
        deadlineAt: input.deadlineAt,
        ...(input.lastCommand !== undefined && {
          lastCommand: input.lastCommand,
        }),
        updatedAt: new Date(),
      })
      .where(eq(workItemSessions.id, id))
      .returning();

    if (!updated) throw new Error(`work item session not found: ${id}`);
    return toRecord(updated);
  }
}
