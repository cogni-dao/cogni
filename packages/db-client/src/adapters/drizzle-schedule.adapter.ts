// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/scheduling/drizzle-schedule`
 * Purpose: Schedule adapters split by trust boundary — user (appDb, RLS enforced) and worker (serviceDb, BYPASSRLS).
 * Scope: Implements ScheduleUserPort and ScheduleWorkerPort with Drizzle ORM. Does not contain worker task logic.
 * Invariants:
 * - Per CRUD_IS_TEMPORAL_AUTHORITY: CRUD endpoints control schedule lifecycle
 * - createSchedule: grant → DB → scheduleControl (on fail: rollback)
 * - NodeTask schedules (input.route set) grant task:dispatch:nodeId:route + route to NodeTaskWorkflow
 * - updateSchedule (enabled): DB → pause/resume (on fail: rollback DB)
 * - deleteSchedule: scheduleControl → DB (on fail: 503, don't delete DB)
 * - Per DB_TIMING_IS_CACHE_ONLY: next_run_at/last_run_at are cache columns
 * - withTenantScope called on every method (uniform invariant, no-op on serviceDb)
 * Side-effects: IO (database operations, schedule control RPC)
 * Links: ports/scheduling/schedule-manager.port.ts, docs/spec/scheduler.md
 * @public
 */

import { schedules } from "@cogni/db-schema/scheduling";
import { type ActorId, type UserId, userActor } from "@cogni/ids";
import {
  type CreateScheduleInput,
  type ExecutionGrantUserPort,
  InvalidCronExpressionError,
  InvalidTimezoneError,
  nodeTaskScope,
  ScheduleAccessDeniedError,
  type ScheduleControlPort,
  ScheduleNotFoundError,
  type ScheduleSpec,
  type ScheduleUserPort,
  type ScheduleWorkerPort,
  type UpdateScheduleInput,
} from "@cogni/scheduler-core";
import cronParser from "cron-parser";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { JsonValue } from "type-fest";
import type { Database, LoggerLike } from "../client";
import { withTenantScope } from "../tenant-scope";

// ── Shared helpers (module-level) ────────────────────────────────

const defaultLogger: LoggerLike = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function computeNextRun(cron: string, timezone: string): Date {
  if (!isValidTimezone(timezone)) {
    throw new InvalidTimezoneError(timezone);
  }

  try {
    const interval = cronParser.parseExpression(cron, {
      currentDate: new Date(),
      tz: timezone,
    });
    return interval.next().toDate();
  } catch (error) {
    if (error instanceof Error) {
      throw new InvalidCronExpressionError(cron, error.message);
    }
    throw error;
  }
}

function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function toSpec(row: typeof schedules.$inferSelect): ScheduleSpec {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    executionGrantId: row.executionGrantId,
    graphId: row.graphId,
    input: row.input,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── User-facing adapter (appDb, RLS enforced) ────────────────────

export class DrizzleScheduleUserAdapter implements ScheduleUserPort {
  private readonly logger: LoggerLike;

  constructor(
    private readonly db: Database,
    private readonly scheduleControl: ScheduleControlPort,
    private readonly grantPort: ExecutionGrantUserPort,
    /**
     * This operator's resolved node id (getNodeId()). Scopes NodeTask grants to
     * `task:dispatch:<nodeId>:<route>` so a schedule cannot dispatch as a foreign node.
     */
    private readonly nodeId: string,
    logger?: LoggerLike
  ) {
    this.logger = logger ?? defaultLogger;
  }

  async createSchedule(
    callerUserId: UserId,
    billingAccountId: string,
    input: CreateScheduleInput
  ): Promise<ScheduleSpec> {
    const actorId = userActor(callerUserId);
    // Validate cron and timezone first (fail fast)
    const nextRunAt = computeNextRun(input.cron, input.timezone);

    // NodeTask (http-dispatch) vs graph schedule. `route` xor `graphId` is enforced
    // upstream by the contract; here we derive the workflow wiring per branch.
    // NodeTask: grant scope = task:dispatch:<nodeId>:<route>, graphId tunnel = task:<route>,
    // workflowType = NodeTaskWorkflow (the schedule-control adapter's configured queue is
    // already this node's per-node queue, so no taskQueueOverride is needed).
    const isNodeTask = input.route !== undefined;
    const route = input.route;
    const grantScope = isNodeTask
      ? nodeTaskScope(this.nodeId, route as string)
      : `graph:execute:${input.graphId}`;
    const storedGraphId = isNodeTask
      ? `task:${route as string}`
      : (input.graphId as string);
    const workflowType = isNodeTask ? "NodeTaskWorkflow" : undefined;
    // NodeTask: tunnel {route, payload} inside `input` so the schedule-control
    // adapter's buildWorkflowArgs unwraps the dispatch route + payload (the user's
    // `input` IS the opaque NodeTask payload). Graph schedules store `input` as-is.
    const storedInput = isNodeTask
      ? { route: route as string, payload: input.input }
      : input.input;

    // Create grant OUTSIDE transaction for atomicity cleanup
    // If schedule insert or scheduleControl fails, we hard-delete the grant
    const grant = await this.grantPort.createGrant({
      userId: callerUserId,
      billingAccountId,
      scopes: [grantScope],
    });

    let row: typeof schedules.$inferSelect | undefined;

    try {
      // Insert schedule into DB with tenant scope
      row = await withTenantScope(this.db, actorId, async (tx) => {
        const [scheduleRow] = await tx
          .insert(schedules)
          .values({
            ownerUserId: callerUserId,
            executionGrantId: grant.id,
            graphId: storedGraphId,
            input: storedInput,
            cron: input.cron,
            timezone: input.timezone,
            enabled: true,
            nextRunAt,
          })
          .returning();

        if (!scheduleRow) {
          throw new Error("Failed to insert schedule");
        }
        return scheduleRow;
      });

      // Per CRUD_IS_TEMPORAL_AUTHORITY: Create schedule in orchestrator
      // Order: grant → DB → scheduleControl (on fail: rollback DB and grant)
      await this.scheduleControl.createSchedule({
        scheduleId: row.id,
        nodeId: input.nodeId,
        dbScheduleId: row.id,
        ownerUserId: callerUserId,
        cron: input.cron,
        timezone: input.timezone,
        graphId: storedGraphId,
        executionGrantId: grant.id,
        input: storedInput as JsonValue,
        workflowType,
      });

      this.logger.info(
        { scheduleId: row.id, graphId: storedGraphId, nextRunAt },
        "Created schedule"
      );

      return toSpec(row);
    } catch (error) {
      // Atomicity cleanup: delete DB row if it was created
      if (row) {
        const rowId = row.id;
        this.logger.warn(
          { scheduleId: rowId },
          "Rolling back schedule DB row after scheduleControl failure"
        );
        await withTenantScope(this.db, actorId, async (tx) => {
          await tx.delete(schedules).where(eq(schedules.id, rowId));
        });
      }

      // Atomicity cleanup: hard-delete the orphan grant
      this.logger.warn(
        { grantId: grant.id },
        "Cleaning up orphan grant after schedule creation failure"
      );
      await this.grantPort.deleteGrant(callerUserId, grant.id);
      throw error;
    }
  }

  async listSchedules(callerUserId: UserId): Promise<readonly ScheduleSpec[]> {
    const actorId = userActor(callerUserId);
    return withTenantScope(this.db, actorId, async (tx) => {
      const rows = await tx.query.schedules.findMany({
        where: eq(schedules.ownerUserId, callerUserId),
      });
      return rows.map((row) => toSpec(row));
    });
  }

  async getSchedule(
    callerUserId: UserId,
    scheduleId: string
  ): Promise<ScheduleSpec | null> {
    const actorId = userActor(callerUserId);
    return withTenantScope(this.db, actorId, async (tx) => {
      const row = await tx.query.schedules.findFirst({
        where: eq(schedules.id, scheduleId),
      });
      return row ? toSpec(row) : null;
    });
  }

  async updateSchedule(
    callerUserId: UserId,
    scheduleId: string,
    patch: UpdateScheduleInput
  ): Promise<ScheduleSpec> {
    const actorId = userActor(callerUserId);

    const existing = await this.getSchedule(callerUserId, scheduleId);
    if (!existing) {
      throw new ScheduleNotFoundError(scheduleId);
    }
    if (existing.ownerUserId !== callerUserId) {
      throw new ScheduleAccessDeniedError(scheduleId, callerUserId);
    }

    const updates: Partial<typeof schedules.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (patch.input !== undefined) {
      updates.input = patch.input;
    }
    if (patch.cron !== undefined) {
      updates.cron = patch.cron;
    }
    if (patch.timezone !== undefined) {
      updates.timezone = patch.timezone;
    }
    if (patch.enabled !== undefined) {
      updates.enabled = patch.enabled;
    }

    // Recompute next_run_at if cron/timezone/enabled changed
    // Per DB_TIMING_IS_CACHE_ONLY: This is cache-only, Temporal is authoritative
    const newCron = patch.cron ?? existing.cron;
    const newTimezone = patch.timezone ?? existing.timezone;
    const newEnabled = patch.enabled ?? existing.enabled;

    if (newEnabled) {
      updates.nextRunAt = computeNextRun(newCron, newTimezone);
    } else {
      updates.nextRunAt = null;
    }

    // Update DB first (scoped)
    const [row] = await withTenantScope(this.db, actorId, async (tx) => {
      return tx
        .update(schedules)
        .set(updates)
        .where(eq(schedules.id, scheduleId))
        .returning();
    });

    if (!row) {
      throw new ScheduleNotFoundError(scheduleId);
    }

    // Per CRUD_IS_TEMPORAL_AUTHORITY: Handle enabled state changes
    // Order: DB → scheduleControl (on fail: rollback DB)
    try {
      if (patch.enabled !== undefined && patch.enabled !== existing.enabled) {
        if (patch.enabled) {
          await this.scheduleControl.resumeSchedule(scheduleId);
          this.logger.info({ scheduleId }, "Resumed schedule");
        } else {
          await this.scheduleControl.pauseSchedule(scheduleId);
          this.logger.info({ scheduleId }, "Paused schedule");
        }
      }
    } catch (error) {
      // Rollback DB changes on scheduleControl failure
      this.logger.warn(
        { scheduleId, error },
        "Rolling back schedule update after scheduleControl failure"
      );
      await withTenantScope(this.db, actorId, async (tx) => {
        await tx
          .update(schedules)
          .set({
            input: existing.input,
            cron: existing.cron,
            timezone: existing.timezone,
            enabled: existing.enabled,
            nextRunAt: existing.nextRunAt,
            updatedAt: existing.updatedAt,
          })
          .where(eq(schedules.id, scheduleId));
      });
      throw error;
    }

    this.logger.info({ scheduleId, patch }, "Updated schedule");

    return toSpec(row);
  }

  async deleteSchedule(
    callerUserId: UserId,
    scheduleId: string
  ): Promise<void> {
    const existing = await this.getSchedule(callerUserId, scheduleId);
    if (!existing) {
      throw new ScheduleNotFoundError(scheduleId);
    }
    if (existing.ownerUserId !== callerUserId) {
      throw new ScheduleAccessDeniedError(scheduleId, callerUserId);
    }

    // Per CRUD_IS_TEMPORAL_AUTHORITY: Delete from scheduleControl FIRST
    // Order: scheduleControl → DB (on fail: 503, don't delete DB)
    // Note: scheduleControl.deleteSchedule is idempotent (no-op if not found)
    await this.scheduleControl.deleteSchedule(scheduleId);

    // Only delete from DB if scheduleControl succeeded
    // Revoke the grant (grant adapter self-scopes)
    await this.grantPort.revokeGrant(callerUserId, existing.executionGrantId);

    // Delete schedule (cascade deletes runs)
    await withTenantScope(this.db, userActor(callerUserId), async (tx) => {
      await tx.delete(schedules).where(eq(schedules.id, scheduleId));
    });

    this.logger.info({ scheduleId }, "Deleted schedule");
  }
}

// ── Worker adapter (serviceDb, BYPASSRLS — withTenantScope is no-op) ─

export class DrizzleScheduleWorkerAdapter implements ScheduleWorkerPort {
  private readonly logger: LoggerLike;

  constructor(
    private readonly db: Database,
    logger?: LoggerLike
  ) {
    this.logger = logger ?? defaultLogger;
  }

  async getScheduleForWorker(
    actorId: ActorId,
    scheduleId: string
  ): Promise<ScheduleSpec | null> {
    return withTenantScope(this.db, actorId, async (tx) => {
      const row = await tx.query.schedules.findFirst({
        where: eq(schedules.id, scheduleId),
      });
      this.logger.info(
        { scheduleId, found: !!row },
        "Fetched schedule for worker"
      );
      return row ? toSpec(row) : null;
    });
  }

  async updateNextRunAt(
    actorId: ActorId,
    scheduleId: string,
    nextRunAt: Date
  ): Promise<void> {
    await withTenantScope(this.db, actorId, async (tx) => {
      await tx
        .update(schedules)
        .set({ nextRunAt, updatedAt: new Date() })
        .where(eq(schedules.id, scheduleId));
    });
    this.logger.info(
      { scheduleId, nextRunAt: nextRunAt.toISOString() },
      "Updated nextRunAt"
    );
  }

  async updateLastRunAt(
    actorId: ActorId,
    scheduleId: string,
    lastRunAt: Date
  ): Promise<void> {
    await withTenantScope(this.db, actorId, async (tx) => {
      await tx
        .update(schedules)
        .set({ lastRunAt, updatedAt: new Date() })
        .where(eq(schedules.id, scheduleId));
    });
    this.logger.info(
      { scheduleId, lastRunAt: lastRunAt.toISOString() },
      "Updated lastRunAt"
    );
  }

  async findStaleSchedules(actorId: ActorId): Promise<readonly ScheduleSpec[]> {
    const now = new Date();
    return withTenantScope(this.db, actorId, async (tx) => {
      // Per RECONCILER_GUARANTEES_CHAIN: Include enabled schedules where
      // next_run_at IS NULL (edge case after re-enable) or next_run_at < now (stale)
      const rows = await tx.query.schedules.findMany({
        where: and(
          eq(schedules.enabled, true),
          or(lt(schedules.nextRunAt, now), isNull(schedules.nextRunAt))
        ),
      });
      this.logger.info({ count: rows.length }, "Found stale schedules");
      return rows.map((row) => toSpec(row));
    });
  }
}
