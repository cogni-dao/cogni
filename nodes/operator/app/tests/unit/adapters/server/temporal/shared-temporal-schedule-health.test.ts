// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/temporal/shared-temporal-schedule-health`
 * Purpose: Prove schedule drift and due terminal execution fail-closed semantics.
 * Scope: Pure/injected unit coverage; no DB or Temporal server.
 * Side-effects: none
 * Links: task.5238
 * @internal
 */

import type { ScheduleDescription } from "@cogni/scheduler-core";
import { describe, expect, it, vi } from "vitest";
import {
  inspectSharedTemporalScheduleHealth,
  TEMPORAL_DUE_EXECUTION_GRACE_MS,
  TEMPORAL_HEALTH_MAX_SCHEDULES,
} from "@/adapters/server/temporal";

const NOW_MS = Date.parse("2026-10-12T12:00:00.000Z");
const TASK_QUEUE = "scheduler-tasks-node-123";
const range = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, index) => start + index);

const expected = {
  dbScheduleId: "00000000-0000-4000-8000-000000000001",
  temporalScheduleId: "schedule-1",
  enabled: true,
  cron: "* * * * *",
  timezone: "UTC",
  input: { message: "probe", model: "gpt-oss-120b" },
  graphId: "langgraph:probe",
  executionGrantId: "grant-1",
  ownerUserId: "user-1",
  workflowType: "GraphRunWorkflow",
  taskQueue: TASK_QUEUE,
  overlapPolicy: "skip",
  catchupWindowMs: 0,
} as const;

function observed(
  patch: Partial<ScheduleDescription> = {}
): ScheduleDescription {
  return {
    scheduleId: expected.temporalScheduleId,
    nodeId: "node-123",
    nextRunAtIso: "2026-10-12T12:01:00.000Z",
    nextRunTimesIso: [
      "2026-10-12T12:01:00.000Z",
      "2026-10-12T12:02:00.000Z",
      "2026-10-12T12:03:00.000Z",
    ],
    lastRunAtIso: "2026-10-12T11:45:00.000Z",
    isPaused: false,
    cron: null,
    timezone: "UTC",
    input: expected.input,
    dbScheduleId: expected.dbScheduleId,
    graphId: expected.graphId,
    executionGrantId: expected.executionGrantId,
    ownerUserId: expected.ownerUserId,
    workflowType: expected.workflowType,
    overlapPolicy: expected.overlapPolicy,
    catchupWindowMs: expected.catchupWindowMs,
    createdAtIso: "2026-10-12T10:00:00.000Z",
    numActionsTaken: 1,
    numActionsMissedCatchupWindow: 0,
    numActionsSkippedOverlap: 0,
    taskQueue: TASK_QUEUE,
    lastWorkflowId: "schedule-1-2026-10-12T11:45:00Z",
    lastWorkflowRunId: "run-1",
    lastWorkflowStatus: "COMPLETED",
    recentActions: [
      {
        scheduledAtIso: "2026-10-12T11:45:00.000Z",
        workflowId: "schedule-1-2026-10-12T11:45:00Z",
        firstExecutionRunId: "run-1",
        status: "COMPLETED",
      },
    ],
    ...patch,
  };
}

describe("shared Temporal schedule health", () => {
  it("reports reconciled schedules with terminal due Workflows healthy", async () => {
    const result = await inspectSharedTemporalScheduleHealth(
      {
        nodeId: "node-123",
        expectedSchedules: [expected],
        expectedTaskQueue: TASK_QUEUE,
      },
      {
        now: () => NOW_MS,
        listScheduleIds: vi
          .fn()
          .mockResolvedValue([expected.temporalScheduleId]),
        describeSchedule: vi.fn().mockResolvedValue(observed()),
      }
    );

    expect(result).toMatchObject({
      status: "healthy",
      reason: "ok",
      declaredCount: 1,
      observedCount: 1,
      reconciledCount: 1,
      driftCount: 0,
      dueCount: 1,
      terminalCount: 1,
      latestDueExecution: {
        workflowId: "schedule-1-2026-10-12T11:45:00Z",
        firstExecutionRunId: "run-1",
        status: "COMPLETED",
      },
    });
  });

  it("reports stable aggregate drift reasons", async () => {
    const result = await inspectSharedTemporalScheduleHealth(
      {
        nodeId: "node-123",
        expectedSchedules: [expected],
        expectedTaskQueue: TASK_QUEUE,
      },
      {
        now: () => NOW_MS,
        listScheduleIds: vi
          .fn()
          .mockResolvedValue([expected.temporalScheduleId]),
        describeSchedule: vi.fn().mockResolvedValue(
          observed({
            isPaused: true,
            taskQueue: "scheduler-tasks-wrong",
            timezone: "America/Los_Angeles",
          })
        ),
      }
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      reason: "schedule_drift",
      driftCount: 1,
      driftReasons: ["pause_state", "task_queue", "timezone"],
    });
  });

  it("compares compiled cron, action identity, ownership, grant, and policies", async () => {
    const result = await inspectSharedTemporalScheduleHealth(
      {
        nodeId: "node-123",
        expectedSchedules: [expected],
        expectedTaskQueue: TASK_QUEUE,
      },
      {
        now: () => NOW_MS,
        listScheduleIds: vi
          .fn()
          .mockResolvedValue([expected.temporalScheduleId]),
        describeSchedule: vi.fn().mockResolvedValue(
          observed({
            nextRunTimesIso: ["2026-10-12T12:05:00.000Z"],
            graphId: "wrong-graph",
            workflowType: "NodeTaskWorkflow",
            executionGrantId: "wrong-grant",
            ownerUserId: "wrong-owner",
            overlapPolicy: "allow_all",
            catchupWindowMs: 60_000,
          })
        ),
      }
    );

    expect(result.reason).toBe("schedule_drift");
    expect(result.driftReasons).toEqual(
      expect.arrayContaining([
        "cron",
        "graph_id",
        "workflow_type",
        "execution_grant",
        "owner",
        "overlap_policy",
        "catchup_window",
      ])
    );
  });

  it("detects compiled cron drift even while the schedule is paused", async () => {
    const disabled = { ...expected, enabled: false };
    const result = await inspectSharedTemporalScheduleHealth(
      {
        nodeId: "node-123",
        expectedSchedules: [disabled],
        expectedTaskQueue: TASK_QUEUE,
      },
      {
        now: () => NOW_MS,
        listScheduleIds: vi
          .fn()
          .mockResolvedValue([expected.temporalScheduleId]),
        describeSchedule: vi.fn().mockResolvedValue(
          observed({
            isPaused: true,
            nextRunAtIso: null,
            nextRunTimesIso: [],
            calendarSpecs: [
              {
                second: [0],
                minute: [0],
                hour: range(0, 23),
                dayOfMonth: range(1, 31),
                month: range(1, 12),
                dayOfWeek: range(0, 6),
              },
            ],
          })
        ),
      }
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      reason: "schedule_drift",
      driftReasons: ["cron"],
    });
  });

  it("reports stale_execution when a due Workflow is not terminal", async () => {
    const result = await inspectSharedTemporalScheduleHealth(
      {
        nodeId: "node-123",
        expectedSchedules: [expected],
        expectedTaskQueue: TASK_QUEUE,
      },
      {
        now: () => NOW_MS,
        listScheduleIds: vi
          .fn()
          .mockResolvedValue([expected.temporalScheduleId]),
        describeSchedule: vi.fn().mockResolvedValue(
          observed({
            lastWorkflowStatus: "RUNNING",
            recentActions: [
              {
                scheduledAtIso: "2026-10-12T11:45:00.000Z",
                workflowId: "workflow-running",
                firstExecutionRunId: "run-running",
                status: "RUNNING",
              },
            ],
          })
        ),
      }
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      reason: "stale_execution",
      dueCount: 1,
      terminalCount: 0,
    });
  });

  it("allows a just-started Workflow the bounded terminal grace period", async () => {
    expect(TEMPORAL_DUE_EXECUTION_GRACE_MS).toBe(15 * 60_000);
    const result = await inspectSharedTemporalScheduleHealth(
      {
        nodeId: "node-123",
        expectedSchedules: [expected],
        expectedTaskQueue: TASK_QUEUE,
      },
      {
        now: () => NOW_MS,
        listScheduleIds: vi
          .fn()
          .mockResolvedValue([expected.temporalScheduleId]),
        describeSchedule: vi.fn().mockResolvedValue(
          observed({
            lastRunAtIso: new Date(
              NOW_MS - TEMPORAL_DUE_EXECUTION_GRACE_MS + 1
            ).toISOString(),
            lastWorkflowStatus: "RUNNING",
            recentActions: [
              {
                scheduledAtIso: new Date(
                  NOW_MS - TEMPORAL_DUE_EXECUTION_GRACE_MS + 1
                ).toISOString(),
                workflowId: "workflow-running",
                firstExecutionRunId: "run-running",
                status: "RUNNING",
              },
            ],
          })
        ),
      }
    );

    expect(result).toMatchObject({
      status: "healthy",
      reason: "ok",
      dueCount: 0,
      terminalCount: 0,
    });
  });

  it("inspects older recent actions even when the newest action completed", async () => {
    const result = await inspectSharedTemporalScheduleHealth(
      {
        nodeId: "node-123",
        expectedSchedules: [expected],
        expectedTaskQueue: TASK_QUEUE,
      },
      {
        now: () => NOW_MS,
        listScheduleIds: vi
          .fn()
          .mockResolvedValue([expected.temporalScheduleId]),
        describeSchedule: vi.fn().mockResolvedValue(
          observed({
            recentActions: [
              {
                scheduledAtIso: "2026-10-12T11:40:00.000Z",
                workflowId: "older-stuck",
                firstExecutionRunId: "older-run",
                status: "RUNNING",
              },
              {
                scheduledAtIso: "2026-10-12T11:59:00.000Z",
                workflowId: "newer-complete",
                firstExecutionRunId: "newer-run",
                status: "COMPLETED",
              },
            ],
          })
        ),
      }
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      reason: "stale_execution",
      staleCount: 1,
    });
  });

  it.each([
    "FAILED",
    "CANCELLED",
    "TERMINATED",
    "TIMED_OUT",
  ] as const)("treats %s as failed execution, never terminal success", async (status) => {
    const result = await inspectSharedTemporalScheduleHealth(
      {
        nodeId: "node-123",
        expectedSchedules: [expected],
        expectedTaskQueue: TASK_QUEUE,
      },
      {
        now: () => NOW_MS,
        listScheduleIds: vi
          .fn()
          .mockResolvedValue([expected.temporalScheduleId]),
        describeSchedule: vi.fn().mockResolvedValue(
          observed({
            recentActions: [
              {
                scheduledAtIso: "2026-10-12T11:59:00.000Z",
                workflowId: "failed-workflow",
                firstExecutionRunId: "failed-run",
                status,
              },
            ],
          })
        ),
      }
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      reason: "failed_execution",
      failedCount: 1,
      terminalCount: 0,
    });
  });

  it("fails an enabled schedule that never fired after a due cadence slot", async () => {
    const result = await inspectSharedTemporalScheduleHealth(
      {
        nodeId: "node-123",
        expectedSchedules: [expected],
        expectedTaskQueue: TASK_QUEUE,
      },
      {
        now: () => NOW_MS,
        listScheduleIds: vi
          .fn()
          .mockResolvedValue([expected.temporalScheduleId]),
        describeSchedule: vi.fn().mockResolvedValue(
          observed({
            lastRunAtIso: null,
            recentActions: [],
            numActionsTaken: 0,
          })
        ),
      }
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      reason: "missed_execution",
      missedCount: 1,
    });
  });

  it("fails when the last success is older than the latest cadence slot due", async () => {
    const result = await inspectSharedTemporalScheduleHealth(
      {
        nodeId: "node-123",
        expectedSchedules: [expected],
        expectedTaskQueue: TASK_QUEUE,
      },
      {
        now: () => NOW_MS,
        listScheduleIds: vi
          .fn()
          .mockResolvedValue([expected.temporalScheduleId]),
        describeSchedule: vi.fn().mockResolvedValue(
          observed({
            recentActions: [
              {
                scheduledAtIso: "2026-10-12T11:30:00.000Z",
                workflowId: "old-success",
                firstExecutionRunId: "old-run",
                status: "COMPLETED",
              },
            ],
          })
        ),
      }
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      reason: "missed_execution",
      missedCount: 1,
    });
  });

  it("passes one absolute deadline into every backend describe", async () => {
    const describeSchedule = vi.fn().mockResolvedValue(observed());
    const listScheduleIds = vi
      .fn()
      .mockResolvedValue([expected.temporalScheduleId]);
    await inspectSharedTemporalScheduleHealth(
      {
        nodeId: "node-123",
        expectedSchedules: [expected],
        expectedTaskQueue: TASK_QUEUE,
      },
      {
        now: () => NOW_MS,
        listScheduleIds,
        describeSchedule,
      }
    );

    expect(listScheduleIds).toHaveBeenCalledWith("", 251, expect.any(Number));
    expect(describeSchedule).toHaveBeenCalledWith(
      expected.temporalScheduleId,
      expect.any(Number)
    );
  });

  it("fails closed when schedule inspection is unavailable", async () => {
    const result = await inspectSharedTemporalScheduleHealth(
      {
        nodeId: "node-123",
        expectedSchedules: [expected],
        expectedTaskQueue: TASK_QUEUE,
      },
      {
        listScheduleIds: vi
          .fn()
          .mockResolvedValue([expected.temporalScheduleId]),
        describeSchedule: vi
          .fn()
          .mockRejectedValue(new Error("Temporal unavailable")),
      }
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      reason: "schedule_inspection_unavailable",
    });
  });

  it("fails before IO when the bounded inventory is exceeded", async () => {
    const describeSchedule = vi.fn();
    const expectedSchedules = Array.from(
      { length: TEMPORAL_HEALTH_MAX_SCHEDULES + 1 },
      (_, index) => ({
        ...expected,
        dbScheduleId: `db-${index}`,
        temporalScheduleId: `schedule-${index}`,
      })
    );

    const result = await inspectSharedTemporalScheduleHealth(
      {
        nodeId: "node-123",
        expectedSchedules,
        expectedTaskQueue: TASK_QUEUE,
      },
      { listScheduleIds: vi.fn(), describeSchedule }
    );

    expect(result.reason).toBe("schedule_inventory_truncated");
    expect(describeSchedule).not.toHaveBeenCalled();
  });

  it("detects an undeclared ghost schedule owned by this node", async () => {
    const ghost = observed({
      scheduleId: "ghost-schedule",
      dbScheduleId: null,
      input: { message: "ghost" },
    });
    const foreign = observed({
      scheduleId: "foreign-schedule",
      nodeId: "another-node",
      dbScheduleId: null,
    });
    const descriptions = new Map([
      [expected.temporalScheduleId, observed()],
      ["ghost-schedule", ghost],
      ["foreign-schedule", foreign],
    ]);

    const result = await inspectSharedTemporalScheduleHealth(
      {
        nodeId: "node-123",
        expectedSchedules: [expected],
        expectedTaskQueue: TASK_QUEUE,
      },
      {
        now: () => NOW_MS,
        listScheduleIds: vi
          .fn()
          .mockResolvedValue([
            expected.temporalScheduleId,
            "ghost-schedule",
            "foreign-schedule",
          ]),
        describeSchedule: vi
          .fn()
          .mockImplementation((id: string) =>
            Promise.resolve(descriptions.get(id))
          ),
      }
    );

    expect(result).toMatchObject({
      status: "unhealthy",
      reason: "schedule_drift",
      declaredCount: 1,
      observedCount: 2,
      driftCount: 1,
      driftReasons: ["undeclared"],
    });
  });
});
