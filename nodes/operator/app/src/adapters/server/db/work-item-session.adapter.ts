// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/db/work-item-session`
 * Purpose: Drizzle adapter for operator work-item execution sessions.
 * Scope: Persistence only. Does not validate work-item existence, enforce
 *   route auth, derive next actions, or call GitHub.
 * Invariants: ONE_ACTIVE_CLAIM_DB_ENFORCED, EXPIRED_CLAIM_SUPERSEDED,
 *   SERVICE_DB_SHARED_COORDINATION.
 * Side-effects: IO (Postgres via injected Drizzle database).
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007,
 *   bug.5136
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";

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
  };
}

function isUniqueViolation(error: unknown): boolean {
  const direct = (error as { code?: unknown })?.code;
  const nested = (error as { cause?: { code?: unknown } })?.cause?.code;
  return direct === "23505" || nested === "23505";
}

export class DrizzleWorkItemSessionAdapter implements WorkItemSessionPort {
  constructor(private readonly db: Database) {}

  async claim(input: {
    readonly workItemId: string;
    readonly claimedByUserId: string;
    readonly claimedByDisplayName: string | null;
    readonly now: Date;
    readonly deadlineAt: Date;
    readonly lastCommand?: string;
  }): Promise<ClaimWorkItemSessionResult> {
    try {
      return await this.db.transaction(async (tx) => {
        const [existingRow] = await tx
          .select()
          .from(workItemSessions)
          .where(
            and(
              eq(workItemSessions.workItemId, input.workItemId),
              inArray(workItemSessions.status, [...OPEN_SESSION_STATUSES])
            )
          )
          .orderBy(desc(workItemSessions.claimedAt))
          .limit(1)
          .for("update");

        if (existingRow) {
          const existing = toRecord(existingRow);
          if (existing.deadlineAt.getTime() >= input.now.getTime()) {
            if (existing.claimedByUserId !== input.claimedByUserId) {
              return { kind: "conflict", session: existing };
            }

            const [updated] = await tx
              .update(workItemSessions)
              .set({
                status: "active",
                deadlineAt: input.deadlineAt,
                ...(input.lastCommand !== undefined && {
                  lastCommand: input.lastCommand,
                }),
                updatedAt: input.now,
              })
              .where(eq(workItemSessions.id, existing.id))
              .returning();

            if (!updated)
              throw new Error(`work item session not found: ${existing.id}`);
            return {
              kind: "claimed",
              claimKind: "refreshed",
              session: toRecord(updated),
            };
          }

          const [superseded] = await tx
            .update(workItemSessions)
            .set({
              status: "superseded",
              closedAt: input.now,
              updatedAt: input.now,
            })
            .where(
              and(
                eq(workItemSessions.id, existing.id),
                inArray(workItemSessions.status, [...OPEN_SESSION_STATUSES]),
                lt(workItemSessions.deadlineAt, input.now)
              )
            )
            .returning({ id: workItemSessions.id });

          if (!superseded) {
            throw new Error(
              `expired work item session could not be superseded: ${existing.id}`
            );
          }
        }

        const [inserted] = await tx
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
        return {
          kind: "claimed",
          claimKind: existingRow ? "reclaimed" : "fresh",
          session: toRecord(inserted),
        };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const conflicted = await this.getOpen(input.workItemId);
      if (!conflicted) throw error;
      if (conflicted.claimedByUserId === input.claimedByUserId) {
        return {
          kind: "claimed",
          claimKind: "refreshed",
          session: await this.refreshExistingClaim(conflicted.id, input),
        };
      }
      return { kind: "conflict", session: conflicted };
    }
  }

  async heartbeat(input: {
    readonly workItemId: string;
    readonly claimedByUserId: string;
    readonly now: Date;
    readonly deadlineAt: Date;
    readonly lastCommand?: string;
  }): Promise<WorkItemSessionRecord | null> {
    const [updated] = await this.db
      .update(workItemSessions)
      .set({
        status: "active",
        lastHeartbeatAt: input.now,
        deadlineAt: input.deadlineAt,
        ...(input.lastCommand !== undefined && {
          lastCommand: input.lastCommand,
        }),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(workItemSessions.workItemId, input.workItemId),
          eq(workItemSessions.claimedByUserId, input.claimedByUserId),
          inArray(workItemSessions.status, [...OPEN_SESSION_STATUSES]),
          gte(workItemSessions.deadlineAt, input.now)
        )
      )
      .returning();

    return updated ? toRecord(updated) : null;
  }

  async linkPr(input: {
    readonly workItemId: string;
    readonly claimedByUserId: string;
    readonly now: Date;
    readonly branch?: string;
    readonly prNumber?: number;
  }): Promise<WorkItemSessionRecord | null> {
    const [updated] = await this.db
      .update(workItemSessions)
      .set({
        ...(input.branch !== undefined && { branch: input.branch }),
        ...(input.prNumber !== undefined && { prNumber: input.prNumber }),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(workItemSessions.workItemId, input.workItemId),
          eq(workItemSessions.claimedByUserId, input.claimedByUserId),
          inArray(workItemSessions.status, [...OPEN_SESSION_STATUSES]),
          gte(workItemSessions.deadlineAt, input.now)
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
      readonly now: Date;
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
        updatedAt: input.now,
      })
      .where(eq(workItemSessions.id, id))
      .returning();

    if (!updated) throw new Error(`work item session not found: ${id}`);
    return toRecord(updated);
  }
}
