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

const expected = {
  dbScheduleId: "00000000-0000-4000-8000-000000000001",
  temporalScheduleId: "schedule-1",
  enabled: true,
  timezone: "UTC",
  input: { message: "probe", model: "gpt-oss-120b" },
} as const;

function observed(
  patch: Partial<ScheduleDescription> = {}
): ScheduleDescription {
  return {
    scheduleId: expected.temporalScheduleId,
    nodeId: "node-123",
    nextRunAtIso: "2026-10-12T12:01:00.000Z",
    lastRunAtIso: "2026-10-12T11:55:00.000Z",
    isPaused: false,
    cron: null,
    timezone: "UTC",
    input: expected.input,
    dbScheduleId: expected.dbScheduleId,
    taskQueue: TASK_QUEUE,
    lastWorkflowId: "schedule-1-2026-10-12T11:55:00Z",
    lastWorkflowRunId: "run-1",
    lastWorkflowStatus: "COMPLETED",
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
        workflowId: "schedule-1-2026-10-12T11:55:00Z",
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
        describeSchedule: vi
          .fn()
          .mockResolvedValue(observed({ lastWorkflowStatus: "RUNNING" })),
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
