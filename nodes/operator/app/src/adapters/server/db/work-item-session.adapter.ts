// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db/work-item-session`
 * Purpose: Drizzle adapter for operator work-item execution sessions.
 * Scope: Persistence only. Does not validate work-item existence, enforce
 *   route auth, derive next actions, or call GitHub.
 * Invariants: ONE_ACTIVE_CLAIM_DB_ENFORCED, SERVICE_DB_SHARED_COORDINATION.
 * Side-effects: IO (Postgres via injected Drizzle database).
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { and, desc, eq, inArray } from "drizzle-orm";

import type {
  ClaimWorkItemSessionResult,
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
    claimedByDisplayName: row.claimedByDisplayName,
    status: row.status as WorkItemSessionRecord["status"],
    claimedAt: row.claimedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    deadlineAt: row.deadlineAt,
    closedAt: row.closedAt,
    lastCommand: row.lastCommand,
    branch: row.branch,
    prNumber: row.prNumber,
    repoFullName: row.repoFullName,
  };
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

  async claim(input: {
    readonly workItemId: string;
    readonly claimedByUserId: string;
    readonly claimedByDisplayName: string | null;
    readonly deadlineAt: Date;
    readonly lastCommand?: string;
  }): Promise<ClaimWorkItemSessionResult> {
    const existing = await this.getOpen(input.workItemId);
    if (existing) {
      if (existing.claimedByUserId !== input.claimedByUserId) {
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
          claimedByUserId: input.claimedByUserId,
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
      if (conflicted.claimedByUserId === input.claimedByUserId) {
        return {
          kind: "claimed",
          session: await this.refreshExistingClaim(conflicted.id, input),
        };
      }
      return { kind: "conflict", session: conflicted };
    }
  }

  async heartbeat(input: {
    readonly workItemId: string;
    readonly claimedByUserId: string;
    readonly deadlineAt: Date;
    readonly lastCommand?: string;
  }): Promise<WorkItemSessionRecord | null> {
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
          eq(workItemSessions.claimedByUserId, input.claimedByUserId),
          inArray(workItemSessions.status, [...OPEN_SESSION_STATUSES])
        )
      )
      .returning();

    return updated ? toRecord(updated) : null;
  }

  async linkPr(input: {
    readonly workItemId: string;
    readonly claimedByUserId: string;
    readonly branch?: string;
    readonly prNumber?: number;
    readonly repoFullName?: string;
  }): Promise<WorkItemSessionRecord | null> {
    const [updated] = await this.db
      .update(workItemSessions)
      .set({
        ...(input.branch !== undefined && { branch: input.branch }),
        ...(input.prNumber !== undefined && { prNumber: input.prNumber }),
        ...(input.repoFullName !== undefined && {
          repoFullName: input.repoFullName,
        }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workItemSessions.workItemId, input.workItemId),
          eq(workItemSessions.claimedByUserId, input.claimedByUserId),
          inArray(workItemSessions.status, [...OPEN_SESSION_STATUSES])
        )
      )
      .returning();

    return updated ? toRecord(updated) : null;
  }

  async lookupActiveByPr(input: {
    readonly repoFullName: string;
    readonly prNumber: number;
  }): Promise<WorkItemSessionRecord | null> {
    const [row] = await this.db
      .select()
      .from(workItemSessions)
      .where(
        and(
          eq(workItemSessions.repoFullName, input.repoFullName),
          eq(workItemSessions.prNumber, input.prNumber),
          inArray(workItemSessions.status, [...OPEN_SESSION_STATUSES])
        )
      )
      .limit(1);

    return row ? toRecord(row) : null;
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
