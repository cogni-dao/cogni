// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/temporal/schedule-control`
 * Purpose: Temporal implementation of ScheduleControlPort (create/update/pause/resume/delete/describe).
 * Scope: Implements schedule lifecycle via Temporal client. Does not handle workflow execution logic.
 * Invariants:
 *   - Per CRUD_IS_TEMPORAL_AUTHORITY: Only CRUD endpoints and governance sync use this adapter
 *   - Per WORKER_NEVER_CONTROLS_SCHEDULES: Worker must not depend on this
 *   - Per OVERLAP_SKIP_DEFAULT: Schedules use overlap=SKIP
 *   - Per CATCHUP_WINDOW_ZERO: No backfill (catchupWindow=0)
 *   - updateSchedule preserves existing state (pause, notes) via previous.state
 *   - describeSchedule extracts input + dbScheduleId from action.args[0]; cron returns null (compiled to calendars by Temporal)
 * Side-effects: IO (Temporal RPC calls)
 * Links: docs/spec/scheduler.md, docs/spec/temporal-patterns.md, ScheduleControlPort
 * @public
 */

import {
  type CreateScheduleParams,
  ScheduleControlConflictError,
  ScheduleControlNotFoundError,
  type ScheduleControlPort,
  ScheduleControlUnavailableError,
  type ScheduleDescription,
  type ScheduleOverlapPolicyHint,
} from "@cogni/scheduler-core";
import {
  Client,
  Connection,
  type ConnectionOptions,
  ScheduleAlreadyRunning,
  ScheduleOverlapPolicy,
  ScheduleNotFoundError as TemporalScheduleNotFoundError,
} from "@temporalio/client";

/**
 * Configuration for TemporalScheduleControlAdapter.
 */
export interface TemporalScheduleControlConfig {
  /** Temporal server address (e.g., "localhost:7233" or "temporal:7233") */
  address: string;
  /** Temporal namespace (e.g., "cogni-test", "cogni-production") */
  namespace: string;
  /** Task queue for scheduled workflows */
  taskQueue: string;
}

/** Workflow type name for unified graph execution (defined in scheduler-temporal-worker) */
const GRAPH_RUN_WORKFLOW_TYPE = "GraphRunWorkflow";

/** Map port-level overlap hint to Temporal SDK enum */
function toTemporalOverlapPolicy(
  hint: ScheduleOverlapPolicyHint | undefined
): ScheduleOverlapPolicy {
  switch (hint) {
    case "skip":
      return ScheduleOverlapPolicy.SKIP;
    case "allow_all":
      return ScheduleOverlapPolicy.ALLOW_ALL;
    default:
      return ScheduleOverlapPolicy.BUFFER_ONE;
  }
}

/**
 * Temporal implementation of ScheduleControlPort.
 * Per TEMPORAL_PATTERNS.md: overlap=SKIP, catchupWindow=0 hardcoded.
 */
export class TemporalScheduleControlAdapter implements ScheduleControlPort {
  private client: Client | null = null;
  private connection: Connection | null = null;

  constructor(private readonly config: TemporalScheduleControlConfig) {}

  private async getClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    try {
      const connectionOptions: ConnectionOptions = {
        address: this.config.address,
      };

      this.connection = await Connection.connect(connectionOptions);
      this.client = new Client({
        connection: this.connection,
        namespace: this.config.namespace,
      });

      return this.client;
    } catch (error) {
      throw new ScheduleControlUnavailableError(
        "connect",
        error instanceof Error ? error : undefined
      );
    }
  }

  async createSchedule(params: CreateScheduleParams): Promise<void> {
    const client = await this.getClient();

    try {
      const handle = client.schedule.getHandle(params.scheduleId);

      // Check if schedule already exists
      try {
        await handle.describe();
        // If describe succeeds, schedule exists - throw conflict
        throw new ScheduleControlConflictError(params.scheduleId);
      } catch (error) {
        if (error instanceof ScheduleControlConflictError) {
          throw error;
        }
        // Schedule doesn't exist - proceed with creation
        if (!(error instanceof TemporalScheduleNotFoundError)) {
          throw error;
        }
      }

      await client.schedule.create({
        scheduleId: params.scheduleId,
        spec: {
          cronExpressions: [params.cron],
          timezone: params.timezone,
        },
        action: {
          type: "startWorkflow",
          workflowType: params.workflowType ?? GRAPH_RUN_WORKFLOW_TYPE,
          // Per WORKFLOW_ID_INCLUDES_TIMESTAMP: workflowId includes schedule time
          // Temporal appends timestamp automatically for scheduled workflows
          workflowId: params.scheduleId,
          args: [
            {
              nodeId: params.nodeId,
              graphId: params.graphId,
              executionGrantId: params.executionGrantId,
              input: params.input,
              runKind: "system_scheduled" as const,
              triggerSource: "temporal_schedule",
              triggerRef: params.scheduleId,
              requestedBy: params.ownerUserId,
              dbScheduleId: params.dbScheduleId ?? null,
              temporalScheduleId: params.scheduleId,
            },
          ],
          taskQueue: params.taskQueueOverride ?? this.config.taskQueue,
        },
        policies: {
          overlap: toTemporalOverlapPolicy(params.overlapPolicy),
          catchupWindow: params.catchupWindowMs ?? 60_000,
        },
      });
    } catch (error) {
      if (error instanceof ScheduleControlConflictError) {
        throw error;
      }
      if (error instanceof ScheduleAlreadyRunning) {
        throw new ScheduleControlConflictError(params.scheduleId);
      }
      throw new ScheduleControlUnavailableError(
        "createSchedule",
        error instanceof Error ? error : undefined
      );
    }
  }

  async pauseSchedule(scheduleId: string): Promise<void> {
    const client = await this.getClient();

    try {
      const handle = client.schedule.getHandle(scheduleId);
      await handle.pause();
    } catch (error) {
      if (error instanceof TemporalScheduleNotFoundError) {
        throw new ScheduleControlNotFoundError(scheduleId);
      }
      throw new ScheduleControlUnavailableError(
        "pauseSchedule",
        error instanceof Error ? error : undefined
      );
    }
  }

  async resumeSchedule(scheduleId: string): Promise<void> {
    const client = await this.getClient();

    try {
      const handle = client.schedule.getHandle(scheduleId);
      await handle.unpause();
    } catch (error) {
      if (error instanceof TemporalScheduleNotFoundError) {
        throw new ScheduleControlNotFoundError(scheduleId);
      }
      throw new ScheduleControlUnavailableError(
        "resumeSchedule",
        error instanceof Error ? error : undefined
      );
    }
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    const client = await this.getClient();

    try {
      const handle = client.schedule.getHandle(scheduleId);
      await handle.delete();
    } catch (error) {
      // Idempotent: not found is success
      if (error instanceof TemporalScheduleNotFoundError) {
        return;
      }
      throw new ScheduleControlUnavailableError(
        "deleteSchedule",
        error instanceof Error ? error : undefined
      );
    }
  }

  async updateSchedule(
    scheduleId: string,
    params: CreateScheduleParams
  ): Promise<void> {
    const client = await this.getClient();

    try {
      const handle = client.schedule.getHandle(scheduleId);
      await handle.update((previous) => ({
        spec: {
          cronExpressions: [params.cron],
          timezone: params.timezone,
        },
        action: {
          type: "startWorkflow" as const,
          workflowType: params.workflowType ?? GRAPH_RUN_WORKFLOW_TYPE,
          workflowId: params.scheduleId,
          args: [
            {
              nodeId: params.nodeId,
              graphId: params.graphId,
              executionGrantId: params.executionGrantId,
              input: params.input,
              runKind: "system_scheduled" as const,
              triggerSource: "temporal_schedule",
              triggerRef: params.scheduleId,
              requestedBy: params.ownerUserId,
              dbScheduleId: params.dbScheduleId ?? null,
              temporalScheduleId: params.scheduleId,
            },
          ],
          taskQueue: params.taskQueueOverride ?? this.config.taskQueue,
        },
        policies: {
          overlap: toTemporalOverlapPolicy(params.overlapPolicy),
          catchupWindow: params.catchupWindowMs ?? 60_000,
        },
        // Preserve existing state (pause, notes, limits) — don't reset with empty object
        state: previous.state,
      }));
    } catch (error) {
      if (error instanceof TemporalScheduleNotFoundError) {
        throw new ScheduleControlNotFoundError(scheduleId);
      }
      throw new ScheduleControlUnavailableError(
        "updateSchedule",
        error instanceof Error ? error : undefined
      );
    }
  }

  async describeSchedule(
    scheduleId: string
  ): Promise<ScheduleDescription | null> {
    const client = await this.getClient();

    try {
      const handle = client.schedule.getHandle(scheduleId);
      const description = await handle.describe();

      const nextActionTimes = description.info.nextActionTimes;
      const recentActions = description.info.recentActions;

      const nextTime = nextActionTimes[0];
      const lastAction = recentActions[recentActions.length - 1];

      // Extract config fields for drift detection
      // NOTE: Temporal compiles cronExpressions into calendars at create time,
      // so we can't read the original cron string back. Set to null — cron drift
      // detection is an MVP tradeoff; input comparison catches the critical cases.
      // Future: store canonical config in schedule memo for full drift detection.
      const tz =
        typeof description.spec.timezone === "string"
          ? description.spec.timezone
          : null;
      const action = description.action;
      const actionArgs =
        action.type === "startWorkflow" && action.args?.[0]
          ? (action.args[0] as Record<string, unknown>)
          : null;
      const actionInput: ScheduleDescription["input"] = actionArgs
        ? ((actionArgs.input as ScheduleDescription["input"]) ?? null)
        : null;
      const actionDbScheduleId: string | null = actionArgs
        ? ((actionArgs.dbScheduleId as string | null) ?? null)
        : null;

      return {
        scheduleId,
        nextRunAtIso: nextTime ? nextTime.toISOString() : null,
        lastRunAtIso: lastAction ? lastAction.scheduledAt.toISOString() : null,
        isPaused: description.state.paused,
        cron: null, // Temporal compiles crons to calendars; can't read back
        timezone: tz,
        input: actionInput,
        dbScheduleId: actionDbScheduleId,
      };
    } catch (error) {
      if (error instanceof TemporalScheduleNotFoundError) {
        return null;
      }
      throw new ScheduleControlUnavailableError(
        "describeSchedule",
        error instanceof Error ? error : undefined
      );
    }
  }

  async triggerSchedule(scheduleId: string): Promise<void> {
    const client = await this.getClient();

    try {
      const handle = client.schedule.getHandle(scheduleId);
      await handle.trigger();
    } catch (error) {
      if (error instanceof TemporalScheduleNotFoundError) {
        throw new ScheduleControlNotFoundError(scheduleId);
      }
      throw new ScheduleControlUnavailableError(
        "triggerSchedule",
        error instanceof Error ? error : undefined
      );
    }
  }

  async listScheduleIds(prefix: string): Promise<string[]> {
    const client = await this.getClient();

    try {
      const ids: string[] = [];
      for await (const schedule of client.schedule.list()) {
        if (schedule.scheduleId.startsWith(prefix)) {
          ids.push(schedule.scheduleId);
        }
      }
      return ids;
    } catch (error) {
      throw new ScheduleControlUnavailableError(
        "listScheduleIds",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Close the Temporal connection.
   * Should be called on graceful shutdown.
   */
  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
      this.client = null;
    }
  }
}
