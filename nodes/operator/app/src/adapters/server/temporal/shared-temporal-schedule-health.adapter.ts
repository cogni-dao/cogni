// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/temporal/shared-temporal-schedule-health`
 * Purpose: Compare one node's declared schedules with Temporal and prove due executions terminate.
 * Scope: Pure orchestration over injected schedule reads. Never mutates schedules or workflows.
 * Invariants:
 *   - TEMPORAL_IS_SCHEDULE_AUTHORITY: observed state comes from Schedule descriptions.
 *   - DUE_EXECUTION_IS_SERVER_OBSERVED: terminal state comes from the Workflow started by Temporal.
 *   - BOUNDED_INVENTORY: an unexpectedly large inventory fails closed instead of timing out silently.
 *   - STABLE_REASONS: response details are fixed enums; schedule IDs never become metric labels.
 * Side-effects: injected IO only
 * Links: task.5238, docs/spec/substrate-temporal.md#one-call-substrate-health
 * @public
 */

import type {
  ScheduleControlPort,
  ScheduleDescription,
} from "@cogni/scheduler-core";

export const TEMPORAL_HEALTH_MAX_SCHEDULES = 50;
export const TEMPORAL_HEALTH_MAX_NAMESPACE_SCHEDULES = 250;
export const TEMPORAL_DUE_EXECUTION_GRACE_MS = 120_000;
export const TEMPORAL_SCHEDULE_INSPECTION_TIMEOUT_MS = 2_500;

export type SharedTemporalScheduleHealthReason =
  | "ok"
  | "schedule_inspection_unavailable"
  | "schedule_inventory_truncated"
  | "schedule_drift"
  | "stale_execution";

export type SharedTemporalScheduleDriftReason =
  | "missing"
  | "undeclared"
  | "node_id"
  | "pause_state"
  | "task_queue"
  | "timezone"
  | "input"
  | "db_schedule_id"
  | "next_action_missing";

export type SharedTemporalWorkflowStatus =
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TERMINATED"
  | "CONTINUED_AS_NEW"
  | "TIMED_OUT"
  | "UNKNOWN";

export interface ExpectedTemporalSchedule {
  readonly dbScheduleId: string;
  readonly temporalScheduleId: string;
  readonly enabled: boolean;
  readonly timezone: string;
  readonly input: unknown;
}

export interface LatestDueExecutionHealth {
  readonly scheduledAt: string;
  readonly workflowId: string | null;
  readonly firstExecutionRunId: string | null;
  readonly status: SharedTemporalWorkflowStatus | null;
}

export interface SharedTemporalScheduleHealth {
  readonly status: "healthy" | "unhealthy";
  readonly reason: SharedTemporalScheduleHealthReason;
  readonly declaredCount: number;
  readonly observedCount: number;
  readonly reconciledCount: number;
  readonly pausedCount: number;
  readonly driftCount: number;
  readonly driftReasons: readonly SharedTemporalScheduleDriftReason[];
  readonly dueCount: number;
  readonly terminalCount: number;
  readonly latestDueExecution: LatestDueExecutionHealth | null;
}

export interface SharedTemporalScheduleHealthInput {
  readonly nodeId: string;
  readonly expectedSchedules: readonly ExpectedTemporalSchedule[];
  readonly expectedTaskQueue: string;
}

export interface SharedTemporalScheduleHealthDeps {
  readonly listScheduleIds: ScheduleControlPort["listScheduleIds"];
  readonly describeSchedule: ScheduleControlPort["describeSchedule"];
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

const TERMINAL_WORKFLOW_STATUSES = new Set<SharedTemporalWorkflowStatus>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
]);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right)
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function scheduleDriftReasons(
  expected: ExpectedTemporalSchedule,
  observed: ScheduleDescription | null,
  expectedTaskQueue: string,
  expectedNodeId: string
): SharedTemporalScheduleDriftReason[] {
  if (!observed) return ["missing"];

  const reasons: SharedTemporalScheduleDriftReason[] = [];
  if (observed.nodeId !== expectedNodeId) reasons.push("node_id");
  if (observed.isPaused !== !expected.enabled) reasons.push("pause_state");
  if (observed.taskQueue !== expectedTaskQueue) reasons.push("task_queue");
  if (observed.timezone !== expected.timezone) reasons.push("timezone");
  if (stableJson(observed.input) !== stableJson(expected.input)) {
    reasons.push("input");
  }
  if (observed.dbScheduleId !== expected.dbScheduleId) {
    reasons.push("db_schedule_id");
  }
  if (expected.enabled && observed.nextRunAtIso === null) {
    reasons.push("next_action_missing");
  }
  return reasons;
}

function emptyHealth(
  reason: SharedTemporalScheduleHealthReason,
  declaredCount: number
): SharedTemporalScheduleHealth {
  return {
    status: reason === "ok" ? "healthy" : "unhealthy",
    reason,
    declaredCount,
    observedCount: 0,
    reconciledCount: 0,
    pausedCount: 0,
    driftCount: 0,
    driftReasons: [],
    dueCount: 0,
    terminalCount: 0,
    latestDueExecution: null,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("schedule inspection deadline exceeded")),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function describeSchedules(
  scheduleIds: readonly string[],
  describeSchedule: ScheduleControlPort["describeSchedule"]
): Promise<readonly (ScheduleDescription | null)[]> {
  return Promise.all(
    scheduleIds.map((scheduleId) => describeSchedule(scheduleId))
  );
}

export async function inspectSharedTemporalScheduleHealth(
  input: SharedTemporalScheduleHealthInput,
  deps: SharedTemporalScheduleHealthDeps
): Promise<SharedTemporalScheduleHealth> {
  const { expectedSchedules } = input;
  if (expectedSchedules.length > TEMPORAL_HEALTH_MAX_SCHEDULES) {
    return emptyHealth(
      "schedule_inventory_truncated",
      expectedSchedules.length
    );
  }
  let scheduleIds: readonly string[];
  let descriptions: readonly (ScheduleDescription | null)[];
  try {
    const snapshot = await withTimeout(
      (async () => {
        const listedIds = await deps.listScheduleIds(
          "",
          TEMPORAL_HEALTH_MAX_NAMESPACE_SCHEDULES + 1
        );
        if (listedIds.length > TEMPORAL_HEALTH_MAX_NAMESPACE_SCHEDULES) {
          return { scheduleIds: listedIds, descriptions: [] };
        }
        const ids = [
          ...new Set([
            ...listedIds,
            ...expectedSchedules.map((row) => row.temporalScheduleId),
          ]),
        ];
        return {
          scheduleIds: ids,
          descriptions: await describeSchedules(ids, deps.describeSchedule),
        };
      })(),
      deps.timeoutMs ?? TEMPORAL_SCHEDULE_INSPECTION_TIMEOUT_MS
    );
    scheduleIds = snapshot.scheduleIds;
    descriptions = snapshot.descriptions;
  } catch {
    return emptyHealth(
      "schedule_inspection_unavailable",
      expectedSchedules.length
    );
  }
  if (scheduleIds.length > TEMPORAL_HEALTH_MAX_NAMESPACE_SCHEDULES) {
    return emptyHealth(
      "schedule_inventory_truncated",
      expectedSchedules.length
    );
  }

  const nowMs = (deps.now ?? Date.now)();
  const descriptionsById = new Map(
    scheduleIds.map((scheduleId, index) => [
      scheduleId,
      descriptions[index] ?? null,
    ])
  );
  const expectedIds = new Set(
    expectedSchedules.map((row) => row.temporalScheduleId)
  );
  const observedForNode = [...descriptionsById.values()].filter(
    (description): description is ScheduleDescription =>
      description?.nodeId === input.nodeId
  );
  const driftReasons = new Set<SharedTemporalScheduleDriftReason>();
  let reconciledCount = 0;
  let pausedCount = 0;
  let driftCount = 0;
  let dueCount = 0;
  let terminalCount = 0;
  let latestDueExecution: LatestDueExecutionHealth | null = null;

  const undeclaredCount = observedForNode.filter(
    (description) => !expectedIds.has(description.scheduleId)
  ).length;
  if (undeclaredCount > 0) driftReasons.add("undeclared");
  driftCount += undeclaredCount;
  pausedCount = observedForNode.filter(
    (description) => description.isPaused
  ).length;

  for (const expected of expectedSchedules) {
    const observed = descriptionsById.get(expected.temporalScheduleId) ?? null;
    const rowDrift = scheduleDriftReasons(
      expected,
      observed,
      input.expectedTaskQueue,
      input.nodeId
    );
    if (rowDrift.length === 0) reconciledCount += 1;
    else {
      driftCount += 1;
      for (const reason of rowDrift) driftReasons.add(reason);
    }
    if (!expected.enabled || !observed?.lastRunAtIso) continue;
    const scheduledAtMs = Date.parse(observed.lastRunAtIso);
    if (
      !Number.isFinite(scheduledAtMs) ||
      nowMs - scheduledAtMs < TEMPORAL_DUE_EXECUTION_GRACE_MS
    ) {
      continue;
    }

    dueCount += 1;
    const execution: LatestDueExecutionHealth = {
      scheduledAt: observed.lastRunAtIso,
      workflowId: observed.lastWorkflowId ?? null,
      firstExecutionRunId: observed.lastWorkflowRunId ?? null,
      status:
        (observed.lastWorkflowStatus as SharedTemporalWorkflowStatus | null) ??
        null,
    };
    if (execution.status && TERMINAL_WORKFLOW_STATUSES.has(execution.status)) {
      terminalCount += 1;
    }
    if (
      !latestDueExecution ||
      execution.scheduledAt > latestDueExecution.scheduledAt
    ) {
      latestDueExecution = execution;
    }
  }

  const reason: SharedTemporalScheduleHealthReason =
    driftCount > 0
      ? "schedule_drift"
      : terminalCount < dueCount
        ? "stale_execution"
        : "ok";
  return {
    status: reason === "ok" ? "healthy" : "unhealthy",
    reason,
    declaredCount: expectedSchedules.length,
    observedCount: observedForNode.length,
    reconciledCount,
    pausedCount,
    driftCount,
    driftReasons: [...driftReasons].sort(),
    dueCount,
    terminalCount,
    latestDueExecution,
  };
}
