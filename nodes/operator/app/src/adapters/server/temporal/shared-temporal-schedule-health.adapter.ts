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
  ScheduleExecutionDescription,
} from "@cogni/scheduler-core";
import cronParser from "cron-parser";

export const TEMPORAL_HEALTH_MAX_SCHEDULES = 50;
export const TEMPORAL_HEALTH_MAX_NAMESPACE_SCHEDULES = 50;
export const TEMPORAL_HEALTH_DESCRIBE_CONCURRENCY = 4;
export const TEMPORAL_HEALTH_RECENT_CADENCE_SLOTS = 5;
export const TEMPORAL_ACTION_START_GRACE_MS = 60_000;
/** Four retryable metadata steps (7m each) plus the 15m graph Activity. */
export const TEMPORAL_GRAPH_RUN_EXECUTION_BUDGET_MS = 43 * 60_000;
/** One retryable metadata step (7m) plus the 15m dispatch Activity. */
export const TEMPORAL_NODE_TASK_EXECUTION_BUDGET_MS = 22 * 60_000;
/** Conservative SLO for the multi-stage ledger workflow and its child Workflows. */
export const TEMPORAL_COLLECT_EPOCH_EXECUTION_BUDGET_MS = 2 * 60 * 60_000;
export const TEMPORAL_SCHEDULE_INSPECTION_TIMEOUT_MS = 2_500;

export type SharedTemporalScheduleHealthReason =
  | "ok"
  | "schedule_inspection_unavailable"
  | "schedule_inventory_truncated"
  | "schedule_drift"
  | "failed_execution"
  | "missed_execution"
  | "stale_execution";

export type SharedTemporalScheduleDriftReason =
  | "missing"
  | "undeclared"
  | "node_id"
  | "pause_state"
  | "cron"
  | "task_queue"
  | "timezone"
  | "input"
  | "db_schedule_id"
  | "graph_id"
  | "workflow_type"
  | "execution_grant"
  | "owner"
  | "overlap_policy"
  | "catchup_window"
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
  readonly cron: string;
  readonly timezone: string;
  readonly input: unknown;
  readonly graphId: string;
  readonly executionGrantId: string;
  readonly ownerUserId: string;
  readonly workflowType: string;
  readonly taskQueue: string;
  readonly overlapPolicy: "skip" | "buffer_one" | "allow_all";
  readonly catchupWindowMs: number;
  /** Workflow-type-specific maximum valid runtime, including Activity retry budgets. */
  readonly executionBudgetMs: number;
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
  readonly failedCount: number;
  readonly staleCount: number;
  readonly missedCount: number;
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

const FAILED_WORKFLOW_STATUSES = new Set<SharedTemporalWorkflowStatus>([
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
]);

function executionHealth(
  execution: ScheduleExecutionDescription,
  executionBudgetMs: number,
  nowMs: number
): "success" | "failed" | "stale" | "pending" {
  if (FAILED_WORKFLOW_STATUSES.has(execution.status)) return "failed";
  if (execution.status === "COMPLETED") {
    return execution.resultOutcome === "succeeded" ? "success" : "failed";
  }
  const startedAtMs = Date.parse(execution.startedAtIso);
  if (!Number.isFinite(startedAtMs)) return "stale";
  return nowMs <= startedAtMs + executionBudgetMs ? "pending" : "stale";
}

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

function cronTimes(
  cron: string,
  timezone: string,
  currentDateMs: number,
  direction: "next" | "prev",
  count: number
): number[] {
  const interval = cronParser.parseExpression(cron, {
    currentDate: new Date(currentDateMs),
    tz: timezone,
  });
  return Array.from({ length: count }, () =>
    interval[direction]().toDate().getTime()
  );
}

function cronSpecMatches(
  expected: ExpectedTemporalSchedule,
  observed: ScheduleDescription,
  nowMs: number
): boolean {
  if (observed.calendarSpecs !== undefined) {
    try {
      const interval = cronParser.parseExpression(expected.cron, {
        currentDate: new Date(nowMs),
        tz: expected.timezone,
      });
      const fields = interval.fields as Record<string, readonly number[]>;
      const expectedCalendar = {
        second: [...(fields.second ?? [])],
        minute: [...(fields.minute ?? [])],
        hour: [...(fields.hour ?? [])],
        dayOfMonth: [...(fields.dayOfMonth ?? [])],
        month: [...(fields.month ?? [])],
        dayOfWeek: [
          ...new Set((fields.dayOfWeek ?? []).map((value) => value % 7)),
        ].sort((left, right) => left - right),
      };
      return (
        stableJson(observed.calendarSpecs) === stableJson([expectedCalendar])
      );
    } catch {
      return false;
    }
  }
  const observedTimes = (observed.nextRunTimesIso ?? []).slice(0, 3);
  if (!expected.enabled) return false;
  if (observedTimes.length === 0) return false;
  try {
    const expectedTimes = cronTimes(
      expected.cron,
      expected.timezone,
      nowMs,
      "next",
      observedTimes.length
    );
    return observedTimes.every((iso, index) => {
      const actualMs = Date.parse(iso);
      return (
        Number.isFinite(actualMs) &&
        Math.abs(actualMs - (expectedTimes[index] ?? Number.NaN)) <= 1_000
      );
    });
  } catch {
    return false;
  }
}

function recentExpectedCadenceSlots(
  expected: ExpectedTemporalSchedule,
  observed: ScheduleDescription,
  nowMs: number
): number[] {
  if (!expected.enabled) return [];
  const cutoffMs =
    nowMs - Math.max(TEMPORAL_ACTION_START_GRACE_MS, expected.catchupWindowMs);
  const createdAtMs = observed.createdAtIso
    ? Date.parse(observed.createdAtIso)
    : Number.NaN;
  const actions = observed.recentActions ?? [];
  const earliestActionMs = actions.reduce(
    (earliest, action) => Math.min(earliest, Date.parse(action.scheduledAtIso)),
    Number.POSITIVE_INFINITY
  );
  try {
    return cronTimes(
      expected.cron,
      expected.timezone,
      cutoffMs + 1,
      "prev",
      TEMPORAL_HEALTH_RECENT_CADENCE_SLOTS
    )
      .filter(
        (slot) =>
          (!Number.isFinite(createdAtMs) || slot >= createdAtMs) &&
          (!Number.isFinite(earliestActionMs) ||
            slot >= earliestActionMs - 1_000)
      )
      .sort((left, right) => left - right);
  } catch {
    return [];
  }
}

function missedCadenceCount(
  expected: ExpectedTemporalSchedule,
  observed: ScheduleDescription,
  nowMs: number
): number {
  const actions = observed.recentActions ?? [];
  const unmatchedSlots = recentExpectedCadenceSlots(
    expected,
    observed,
    nowMs
  ).filter(
    (slot) =>
      !actions.some((action) => {
        const actionAt = Date.parse(action.scheduledAtIso);
        return Number.isFinite(actionAt) && Math.abs(actionAt - slot) <= 1_000;
      })
  ).length;
  const unexplainedSlots = Math.max(
    0,
    unmatchedSlots - (observed.numActionsSkippedOverlap ?? 0)
  );
  return Math.max(
    unexplainedSlots,
    observed.numActionsMissedCatchupWindow ?? 0
  );
}

function scheduleDriftReasons(
  expected: ExpectedTemporalSchedule,
  observed: ScheduleDescription | null,
  expectedNodeId: string,
  nowMs: number
): SharedTemporalScheduleDriftReason[] {
  if (!observed) return ["missing"];

  const reasons: SharedTemporalScheduleDriftReason[] = [];
  if (observed.nodeId !== expectedNodeId) reasons.push("node_id");
  if (observed.isPaused !== !expected.enabled) reasons.push("pause_state");
  if (!cronSpecMatches(expected, observed, nowMs)) reasons.push("cron");
  if (observed.taskQueue !== expected.taskQueue) reasons.push("task_queue");
  if (observed.timezone !== expected.timezone) reasons.push("timezone");
  if (stableJson(observed.input) !== stableJson(expected.input)) {
    reasons.push("input");
  }
  if (observed.dbScheduleId !== expected.dbScheduleId) {
    reasons.push("db_schedule_id");
  }
  if (observed.graphId !== expected.graphId) reasons.push("graph_id");
  if (observed.workflowType !== expected.workflowType) {
    reasons.push("workflow_type");
  }
  if (observed.executionGrantId !== expected.executionGrantId) {
    reasons.push("execution_grant");
  }
  if (observed.ownerUserId !== expected.ownerUserId) reasons.push("owner");
  if (observed.overlapPolicy !== expected.overlapPolicy) {
    reasons.push("overlap_policy");
  }
  if (observed.catchupWindowMs !== expected.catchupWindowMs) {
    reasons.push("catchup_window");
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
    failedCount: 0,
    staleCount: 0,
    missedCount: 0,
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
  describeSchedule: ScheduleControlPort["describeSchedule"],
  deadlineAtMs: number
): Promise<readonly (ScheduleDescription | null)[]> {
  const descriptions: (ScheduleDescription | null)[] = [];
  for (
    let offset = 0;
    offset < scheduleIds.length;
    offset += TEMPORAL_HEALTH_DESCRIBE_CONCURRENCY
  ) {
    const batch = scheduleIds.slice(
      offset,
      offset + TEMPORAL_HEALTH_DESCRIBE_CONCURRENCY
    );
    descriptions.push(
      ...(await Promise.all(
        batch.map((scheduleId) => describeSchedule(scheduleId, deadlineAtMs))
      ))
    );
  }
  return descriptions;
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
    const timeoutMs = deps.timeoutMs ?? TEMPORAL_SCHEDULE_INSPECTION_TIMEOUT_MS;
    const deadlineAtMs = Date.now() + timeoutMs;
    const snapshot = await withTimeout(
      (async () => {
        const listedIds = await deps.listScheduleIds(
          "",
          TEMPORAL_HEALTH_MAX_NAMESPACE_SCHEDULES + 1,
          deadlineAtMs
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
          descriptions: await describeSchedules(
            ids,
            deps.describeSchedule,
            deadlineAtMs
          ),
        };
      })(),
      timeoutMs
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
  let failedCount = 0;
  let staleCount = 0;
  let missedCount = 0;
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
      input.nodeId,
      nowMs
    );
    if (rowDrift.length === 0) reconciledCount += 1;
    else {
      driftCount += 1;
      for (const reason of rowDrift) driftReasons.add(reason);
    }
    if (!expected.enabled || !observed) continue;

    const actions = observed.recentActions ?? [];
    for (const action of actions) {
      const health = executionHealth(action, expected.executionBudgetMs, nowMs);
      if (health === "pending") continue;
      const execution: LatestDueExecutionHealth = {
        scheduledAt: action.scheduledAtIso,
        workflowId: action.workflowId,
        firstExecutionRunId: action.firstExecutionRunId,
        status: action.status,
      };
      if (
        !latestDueExecution ||
        execution.scheduledAt > latestDueExecution.scheduledAt
      ) {
        latestDueExecution = execution;
      }
      if (health === "failed") failedCount += 1;
      if (health === "stale") staleCount += 1;
      dueCount += 1;
      if (health === "success") terminalCount += 1;
    }

    missedCount += missedCadenceCount(expected, observed, nowMs);
  }

  const reason: SharedTemporalScheduleHealthReason =
    driftCount > 0
      ? "schedule_drift"
      : failedCount > 0
        ? "failed_execution"
        : staleCount > 0
          ? "stale_execution"
          : missedCount > 0
            ? "missed_execution"
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
    failedCount,
    staleCount,
    missedCount,
    latestDueExecution,
  };
}
