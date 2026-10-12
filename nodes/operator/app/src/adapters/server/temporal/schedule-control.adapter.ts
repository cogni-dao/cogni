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
 *   - WORKFLOWTYPE_ROUTING (task.5029): workflowType selects the args envelope — NodeTaskWorkflow gets a NodeTaskInput ({route,payload} unwrapped from input, no migration); all others get GraphRunWorkflowInput. buildWorkflowArgs is the single builder.
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
  type CalendarSpecDescription,
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
/** Workflow type name for the generic non-graph node-task dispatch (task.5029). */
const NODE_TASK_WORKFLOW_TYPE = "NodeTaskWorkflow";
const MAX_HEALTH_RECENT_ACTIONS = 5;
const SEMANTIC_RESULT_WORKFLOW_TYPES = new Set([
  GRAPH_RUN_WORKFLOW_TYPE,
  NODE_TASK_WORKFLOW_TYPE,
]);
const MONTH_NAMES = [
  "JANUARY",
  "FEBRUARY",
  "MARCH",
  "APRIL",
  "MAY",
  "JUNE",
  "JULY",
  "AUGUST",
  "SEPTEMBER",
  "OCTOBER",
  "NOVEMBER",
  "DECEMBER",
] as const;
const DAY_NAMES = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

function expandNumericRanges(
  ranges: readonly { start: number; end: number; step: number }[]
): number[] {
  return ranges.flatMap((range) => {
    const step = Math.max(1, range.step);
    const end = Math.max(range.start, range.end);
    const values: number[] = [];
    for (let value = range.start; value <= end; value += step) {
      values.push(value);
    }
    return values;
  });
}

function expandNamedRanges<T extends string>(
  ranges: readonly { start: T; end: T; step: number }[],
  names: readonly T[],
  offset = 0
): number[] {
  return ranges.flatMap((range) => {
    const start = names.indexOf(range.start);
    const rawEnd = names.indexOf(range.end);
    const end = Math.max(start, rawEnd);
    const step = Math.max(1, range.step);
    const values: number[] = [];
    for (let value = start; value <= end; value += step) {
      values.push(value + offset);
    }
    return values;
  });
}

function calendarDescription(calendar: CalendarSpecDescription) {
  return {
    second: expandNumericRanges(calendar.second),
    minute: expandNumericRanges(calendar.minute),
    hour: expandNumericRanges(calendar.hour),
    dayOfMonth: expandNumericRanges(calendar.dayOfMonth),
    month: expandNamedRanges(calendar.month, MONTH_NAMES, 1),
    dayOfWeek: expandNamedRanges(calendar.dayOfWeek, DAY_NAMES),
  };
}

function overlapPolicyName(
  policy: (typeof ScheduleOverlapPolicy)[keyof typeof ScheduleOverlapPolicy]
): "skip" | "buffer_one" | "allow_all" | "unknown" {
  switch (policy) {
    case ScheduleOverlapPolicy.SKIP:
      return "skip";
    case ScheduleOverlapPolicy.BUFFER_ONE:
      return "buffer_one";
    case ScheduleOverlapPolicy.ALLOW_ALL:
      return "allow_all";
    default:
      return "unknown";
  }
}

/**
 * Build the workflow `args[0]` envelope for a schedule.
 *
 * Storage decision (no migration — design § Storage): for a NodeTask the
 * `{route, payload}` tunnel inside `input` and `graph_id` carries `task:<route>`.
 * This unwraps that into the `NodeTaskInput` the NodeTaskWorkflow expects; every
 * other workflowType keeps the canonical GraphRunWorkflowInput shape (CollectEpoch
 * etc. ignore graph fields and read `input`).
 */
function buildWorkflowArgs(
  params: CreateScheduleParams,
  workflowType: string
): Record<string, unknown> {
  if (workflowType === NODE_TASK_WORKFLOW_TYPE) {
    const input =
      params.input && typeof params.input === "object"
        ? (params.input as Record<string, unknown>)
        : {};
    const route =
      typeof input.route === "string"
        ? input.route
        : // Fallback: derive from the `task:<route>` graphId tunnel.
          params.graphId.startsWith("task:")
          ? params.graphId.slice("task:".length)
          : params.graphId;
    const payload =
      input.payload && typeof input.payload === "object"
        ? (input.payload as Record<string, unknown>)
        : {};
    return {
      nodeId: params.nodeId,
      route,
      payload,
      executionGrantId: params.executionGrantId,
      runKind: "system_scheduled" as const,
      triggerSource: "temporal_schedule",
      scheduleId: params.scheduleId,
      requestedBy: params.ownerUserId,
    };
  }

  // Default: the unified GraphRunWorkflowInput shape.
  return {
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
  };
}

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
  private clientPromise: Promise<Client> | null = null;

  constructor(private readonly config: TemporalScheduleControlConfig) {}

  private async getClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }
    if (this.clientPromise) return this.clientPromise;

    this.clientPromise = (async () => {
      const connectionOptions: ConnectionOptions = {
        address: this.config.address,
      };

      this.connection = await Connection.connect({
        ...connectionOptions,
        connectTimeout: 1_200,
      });
      this.client = new Client({
        connection: this.connection,
        namespace: this.config.namespace,
      });

      return this.client;
    })();
    try {
      return await this.clientPromise;
    } catch (error) {
      this.clientPromise = null;
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

      const workflowType = params.workflowType ?? GRAPH_RUN_WORKFLOW_TYPE;
      await client.schedule.create({
        scheduleId: params.scheduleId,
        spec: {
          cronExpressions: [params.cron],
          timezone: params.timezone,
        },
        action: {
          type: "startWorkflow",
          workflowType,
          // Per WORKFLOW_ID_INCLUDES_TIMESTAMP: workflowId includes schedule time
          // Temporal appends timestamp automatically for scheduled workflows
          workflowId: params.scheduleId,
          args: [buildWorkflowArgs(params, workflowType)],
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
      const workflowType = params.workflowType ?? GRAPH_RUN_WORKFLOW_TYPE;
      await handle.update((previous) => ({
        spec: {
          cronExpressions: [params.cron],
          timezone: params.timezone,
        },
        action: {
          type: "startWorkflow" as const,
          workflowType,
          workflowId: params.scheduleId,
          args: [buildWorkflowArgs(params, workflowType)],
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
    scheduleId: string,
    deadlineAtMs?: number
  ): Promise<ScheduleDescription | null> {
    const client = await this.getClient();

    try {
      const handle = client.schedule.getHandle(scheduleId);
      const description = deadlineAtMs
        ? await client.schedule.withDeadline(deadlineAtMs, () =>
            handle.describe()
          )
        : await handle.describe();

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
        ? actionArgs.route && typeof actionArgs.route === "string"
          ? ({
              route: actionArgs.route,
              payload:
                actionArgs.payload && typeof actionArgs.payload === "object"
                  ? actionArgs.payload
                  : {},
            } as ScheduleDescription["input"])
          : ((actionArgs.input as ScheduleDescription["input"]) ?? null)
        : null;
      const actionDbScheduleId: string | null = actionArgs
        ? ((actionArgs.dbScheduleId as string | null) ??
          (actionArgs.scheduleId as string | null) ??
          null)
        : null;
      const actionGraphId: string | null = actionArgs
        ? typeof actionArgs.graphId === "string"
          ? actionArgs.graphId
          : typeof actionArgs.route === "string"
            ? `task:${actionArgs.route}`
            : null
        : null;
      // bug.5023: expose the action's task queue so a queue migration (e.g. shared
      // `ledger-tasks` → per-node `ledger-tasks-<nodeId>`) is detected as drift.
      const actionTaskQueue: string | null =
        action.type === "startWorkflow" && typeof action.taskQueue === "string"
          ? action.taskQueue
          : null;
      const boundedRecentActions = recentActions.slice(
        -MAX_HEALTH_RECENT_ACTIONS
      );
      const recentWorkflowIds = new Set(
        boundedRecentActions.map((item) => item.action.workflow.workflowId)
      );
      const actionRefs = [
        ...boundedRecentActions.map((item) => ({
          scheduledAt: item.scheduledAt,
          workflow: item.action.workflow,
        })),
        ...description.info.runningActions
          .filter((item) => !recentWorkflowIds.has(item.workflow.workflowId))
          .map((item) => ({ scheduledAt: null, workflow: item.workflow })),
      ];
      const semanticResultRequired =
        action.type === "startWorkflow" &&
        SEMANTIC_RESULT_WORKFLOW_TYPES.has(action.workflowType);
      const recentWorkflowDescriptions = (
        await Promise.all(
          actionRefs.map(async (item) => {
            const workflowHandle = client.workflow.getHandle(
              item.workflow.workflowId,
              undefined,
              { firstExecutionRunId: item.workflow.firstExecutionRunId }
            );
            const workflowDescription = await (deadlineAtMs
              ? client.workflow.withDeadline(deadlineAtMs, () =>
                  workflowHandle.describe()
                )
              : workflowHandle.describe()
            ).catch(() => null);
            let resultOutcome: "succeeded" | "failed" | "unknown" =
              workflowDescription?.status.name === "COMPLETED" &&
              !semanticResultRequired
                ? "succeeded"
                : "unknown";
            if (
              workflowDescription?.status.name === "COMPLETED" &&
              semanticResultRequired
            ) {
              const result = await (deadlineAtMs
                ? client.workflow.withDeadline(deadlineAtMs, () =>
                    workflowHandle.result()
                  )
                : workflowHandle.result()
              ).catch(() => null);
              resultOutcome =
                result && typeof result === "object" && "ok" in result
                  ? (result as { ok?: unknown }).ok === true
                    ? "succeeded"
                    : "failed"
                  : "unknown";
            }
            return {
              scheduledAtIso:
                item.scheduledAt?.toISOString() ??
                workflowDescription?.startTime.toISOString() ??
                description.info.createdAt.toISOString(),
              startedAtIso:
                workflowDescription?.startTime.toISOString() ??
                item.scheduledAt?.toISOString() ??
                description.info.createdAt.toISOString(),
              workflowId: item.workflow.workflowId,
              firstExecutionRunId: item.workflow.firstExecutionRunId,
              status:
                workflowDescription?.status.name === "UNSPECIFIED"
                  ? ("UNKNOWN" as const)
                  : (workflowDescription?.status.name ?? ("UNKNOWN" as const)),
              resultOutcome,
            };
          })
        )
      ).sort((left, right) =>
        left.scheduledAtIso.localeCompare(right.scheduledAtIso)
      );
      const lastWorkflowDescription = recentWorkflowDescriptions.at(-1) ?? null;

      return {
        scheduleId,
        nodeId:
          actionArgs && typeof actionArgs.nodeId === "string"
            ? actionArgs.nodeId
            : null,
        nextRunAtIso: nextTime ? nextTime.toISOString() : null,
        nextRunTimesIso: nextActionTimes.map((time) => time.toISOString()),
        calendarSpecs: (description.spec.calendars ?? []).map(
          calendarDescription
        ),
        lastRunAtIso: lastAction ? lastAction.scheduledAt.toISOString() : null,
        isPaused: description.state.paused,
        cron: null, // Temporal compiles crons to calendars; can't read back
        timezone: tz,
        input: actionInput,
        dbScheduleId: actionDbScheduleId,
        graphId: actionGraphId,
        executionGrantId:
          actionArgs && typeof actionArgs.executionGrantId === "string"
            ? actionArgs.executionGrantId
            : null,
        ownerUserId:
          actionArgs && typeof actionArgs.requestedBy === "string"
            ? actionArgs.requestedBy
            : null,
        workflowType:
          action.type === "startWorkflow" ? action.workflowType : null,
        overlapPolicy: overlapPolicyName(description.policies.overlap),
        catchupWindowMs: description.policies.catchupWindow,
        createdAtIso: description.info.createdAt.toISOString(),
        numActionsTaken: description.info.numActionsTaken,
        numActionsMissedCatchupWindow:
          description.info.numActionsMissedCatchupWindow,
        numActionsSkippedOverlap: description.info.numActionsSkippedOverlap,
        lastWorkflowId: lastWorkflowDescription?.workflowId ?? null,
        lastWorkflowRunId: lastWorkflowDescription?.firstExecutionRunId ?? null,
        lastWorkflowStatus: lastWorkflowDescription?.status ?? null,
        recentActions: recentWorkflowDescriptions,
        taskQueue: actionTaskQueue,
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

  async listScheduleIds(
    prefix: string,
    limit?: number,
    deadlineAtMs?: number
  ): Promise<string[]> {
    const client = await this.getClient();

    try {
      const read = async () => {
        const ids: string[] = [];
        for await (const schedule of client.schedule.list()) {
          if (schedule.scheduleId.startsWith(prefix)) {
            ids.push(schedule.scheduleId);
            if (limit !== undefined && ids.length >= limit) break;
          }
        }
        return ids;
      };
      return deadlineAtMs
        ? await client.schedule.withDeadline(deadlineAtMs, read)
        : await read();
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
      this.clientPromise = null;
    }
  }
}
