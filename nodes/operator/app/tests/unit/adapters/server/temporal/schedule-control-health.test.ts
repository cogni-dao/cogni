// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/temporal/schedule-control-health`
 * Purpose: Prove health descriptions use cancellable deadlines and expose full Schedule/action evidence.
 * Scope: Temporal client mock only; no network or server.
 * Side-effects: none
 * Links: task.5238
 * @internal
 */

import { describe, expect, it, vi } from "vitest";
import { TemporalScheduleControlAdapter } from "@/adapters/server/temporal";

describe("TemporalScheduleControlAdapter health description", () => {
  it("bounds Schedule and Workflow describes with the caller deadline", async () => {
    const deadlineAtMs = Date.now() + 2_000;
    const scheduleDescribe = vi.fn().mockResolvedValue({
      spec: {
        timezone: "UTC",
        calendars: [
          {
            second: [{ start: 0, end: 0, step: 1 }],
            minute: [{ start: 0, end: 55, step: 5 }],
            hour: [{ start: 0, end: 23, step: 1 }],
            dayOfMonth: [{ start: 1, end: 31, step: 1 }],
            month: [{ start: "JANUARY", end: "DECEMBER", step: 1 }],
            year: [],
            dayOfWeek: [{ start: "SUNDAY", end: "SATURDAY", step: 1 }],
          },
        ],
      },
      action: {
        type: "startWorkflow",
        workflowType: "GraphRunWorkflow",
        workflowId: "schedule-1",
        taskQueue: "scheduler-tasks-node-123",
        args: [
          {
            nodeId: "node-123",
            graphId: "langgraph:probe",
            executionGrantId: "grant-1",
            input: { prompt: "probe" },
            dbScheduleId: "db-1",
            requestedBy: "user-1",
          },
        ],
      },
      policies: {
        overlap: "SKIP",
        catchupWindow: 0,
        pauseOnFailure: false,
      },
      state: { paused: false },
      info: {
        nextActionTimes: [new Date("2026-10-12T12:05:00.000Z")],
        recentActions: [
          {
            scheduledAt: new Date("2026-10-12T12:00:00.000Z"),
            action: {
              type: "startWorkflow",
              workflow: {
                workflowId: "workflow-1",
                firstExecutionRunId: "run-1",
              },
            },
          },
        ],
        runningActions: [],
        createdAt: new Date("2026-10-12T11:00:00.000Z"),
        lastUpdatedAt: undefined,
        numActionsTaken: 1,
        numActionsMissedCatchupWindow: 0,
        numActionsSkippedOverlap: 0,
      },
    });
    const workflowDescribe = vi.fn().mockResolvedValue({
      startTime: new Date("2026-10-12T12:00:00.000Z"),
      status: { name: "COMPLETED" },
    });
    const scheduleWithDeadline = vi.fn((_deadline, fn) => fn());
    const workflowWithDeadline = vi.fn((_deadline, fn) => fn());
    const client = {
      schedule: {
        getHandle: () => ({ describe: scheduleDescribe }),
        withDeadline: scheduleWithDeadline,
      },
      workflow: {
        getHandle: () => ({ describe: workflowDescribe }),
        withDeadline: workflowWithDeadline,
      },
    };
    const adapter = new TemporalScheduleControlAdapter({
      address: "temporal:7233",
      namespace: "cogni-production",
      taskQueue: "scheduler-tasks-node-123",
    });
    (adapter as unknown as { client: typeof client }).client = client;

    const result = await adapter.describeSchedule("schedule-1", deadlineAtMs);

    expect(scheduleWithDeadline).toHaveBeenCalledWith(
      deadlineAtMs,
      expect.any(Function)
    );
    expect(workflowWithDeadline).toHaveBeenCalledWith(
      deadlineAtMs,
      expect.any(Function)
    );
    expect(result).toMatchObject({
      graphId: "langgraph:probe",
      workflowType: "GraphRunWorkflow",
      executionGrantId: "grant-1",
      ownerUserId: "user-1",
      overlapPolicy: "skip",
      catchupWindowMs: 0,
      calendarSpecs: [
        {
          second: [0],
          minute: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55],
          month: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        },
      ],
      recentActions: [
        {
          workflowId: "workflow-1",
          firstExecutionRunId: "run-1",
          status: "COMPLETED",
        },
      ],
    });
  });
});
