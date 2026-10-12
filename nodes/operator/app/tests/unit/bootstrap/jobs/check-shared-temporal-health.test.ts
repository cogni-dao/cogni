// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/jobs/check-shared-temporal-health`
 * Purpose: Prove current-node queue and /version identity composition plus metric recording.
 * Scope: Mocked bootstrap job only; no network or Temporal server.
 * Invariants: Queue is base-nodeId and successful checks update bounded-label metrics once.
 * Side-effects: process env (stubbed)
 * Links: task.5238
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  inspectSchedules: vi.fn(),
  counterInc: vi.fn(),
  driftSet: vi.fn(),
  durationObserve: vi.fn(),
  lastSuccessSet: vi.fn(),
  pollerSet: vi.fn(),
  nodeDeclarations: [] as Array<Record<string, unknown>>,
  governanceDeclarations: [] as Array<Record<string, unknown>>,
  jobDeclarations: [] as Array<Record<string, unknown>>,
  rows: [
    {
      dbScheduleId: "00000000-0000-4000-8000-000000000001",
      temporalScheduleId: "probe-schedule",
      ownerUserId: "user-1",
      executionGrantId: "grant-1",
      graphId: "langgraph:probe",
      enabled: true,
      cron: "* * * * *",
      timezone: "UTC",
      input: { message: "probe" },
    },
  ],
}));

vi.mock("@/adapters/server", () => ({
  inspectSharedTemporalHealth: (...args: unknown[]) => mocks.inspect(...args),
  inspectSharedTemporalScheduleHealth: (...args: unknown[]) =>
    mocks.inspectSchedules(...args),
  TEMPORAL_HEALTH_MAX_SCHEDULES: 50,
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    scheduleControl: {
      describeSchedule: vi.fn(),
      listScheduleIds: vi.fn(),
    },
  }),
  resolveServiceDb: () => ({
    select: () => ({
      from: () => ({ limit: () => Promise.resolve(mocks.rows) }),
    }),
  }),
}));

vi.mock("@/shared/config", () => ({
  getGovernanceConfig: () => ({ schedules: mocks.governanceDeclarations }),
  getNodeId: () => "node-123",
  getNodeName: () => "operator",
  getNodeSchedules: () => mocks.nodeDeclarations,
}));

vi.mock("@/shared/node-app-scaffold/scheduled-jobs", () => ({
  defineScheduledJob: (definition: unknown) => definition,
  listScheduledJobs: () => mocks.jobDeclarations,
}));

vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => ({
    APP_BUILD_SHA: "a".repeat(40),
    TEMPORAL_ADDRESS: "temporal:7233",
    TEMPORAL_NAMESPACE: "cogni-production",
    TEMPORAL_TASK_QUEUE: "scheduler-tasks",
    SCHEDULER_WORKER_HEALTH_URL: "http://scheduler-worker:9000",
  }),
}));

vi.mock("@/shared/observability/server/metrics", () => ({
  temporalScheduleDrift: { set: mocks.driftSet },
  temporalSubstrateChecksTotal: {
    labels: () => ({ inc: mocks.counterInc }),
  },
  temporalSubstrateCheckDurationMs: {
    labels: () => ({ observe: mocks.durationObserve }),
  },
  temporalSubstrateLastSuccessTimestampSeconds: {
    set: mocks.lastSuccessSet,
  },
  temporalSubstratePollerFresh: {
    labels: () => ({ set: mocks.pollerSet }),
  },
}));

import { checkSharedTemporalHealth } from "@/bootstrap/jobs/checkSharedTemporalHealth.job";

describe("checkSharedTemporalHealth job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nodeDeclarations.length = 0;
    mocks.governanceDeclarations.length = 0;
    mocks.jobDeclarations.length = 0;
    vi.stubEnv("npm_package_version", "unknown");
    vi.stubEnv("BUILD_TIME", "2026-10-11T11:00:00.000Z");
    mocks.inspect.mockResolvedValue({
      status: "healthy",
      reason: "ok",
      durationMs: 42,
      pollers: { workflow: { status: "fresh" }, activity: { status: "fresh" } },
    });
    mocks.inspectSchedules.mockResolvedValue({
      status: "healthy",
      reason: "ok",
      declaredCount: 1,
      observedCount: 1,
      reconciledCount: 1,
      pausedCount: 0,
      driftCount: 0,
      driftReasons: [],
      dueCount: 1,
      terminalCount: 1,
      failedCount: 0,
      staleCount: 0,
      missedCount: 0,
      latestDueExecution: null,
    });
  });

  it("uses exact /version sources and the current node's shared queue", async () => {
    await checkSharedTemporalHealth();

    expect(mocks.inspect).toHaveBeenCalledWith({
      nodeId: "node-123",
      temporalAddress: "temporal:7233",
      namespace: "cogni-production",
      taskQueue: "scheduler-tasks-node-123",
      schedulerWorkerHealthUrl: "http://scheduler-worker:9000",
      app: {
        version: "unknown",
        buildSha: "a".repeat(40),
        buildTime: "2026-10-11T11:00:00.000Z",
      },
    });
    expect(mocks.inspectSchedules).toHaveBeenCalledWith(
      {
        nodeId: "node-123",
        expectedSchedules: [
          {
            dbScheduleId: "00000000-0000-4000-8000-000000000001",
            temporalScheduleId: "probe-schedule",
            enabled: true,
            cron: "* * * * *",
            timezone: "UTC",
            input: { message: "probe" },
            graphId: "langgraph:probe",
            executionGrantId: "grant-1",
            ownerUserId: "user-1",
            workflowType: "GraphRunWorkflow",
            taskQueue: "scheduler-tasks-node-123",
            overlapPolicy: "buffer_one",
            catchupWindowMs: 60_000,
          },
        ],
        expectedTaskQueue: "scheduler-tasks-node-123",
      },
      {
        describeSchedule: expect.any(Function),
        listScheduleIds: expect.any(Function),
      }
    );
    expect(mocks.counterInc).toHaveBeenCalledOnce();
    expect(mocks.durationObserve).toHaveBeenCalledWith(expect.any(Number));
    expect(mocks.pollerSet).toHaveBeenCalledTimes(2);
    expect(mocks.driftSet).toHaveBeenCalledWith(0);
    expect(mocks.lastSuccessSet).toHaveBeenCalledOnce();
  });

  it("fails the combined check when a due execution is stale", async () => {
    mocks.inspectSchedules.mockResolvedValue({
      status: "unhealthy",
      reason: "stale_execution",
      declaredCount: 1,
      observedCount: 1,
      reconciledCount: 1,
      pausedCount: 0,
      driftCount: 0,
      driftReasons: [],
      dueCount: 1,
      terminalCount: 0,
      failedCount: 0,
      staleCount: 1,
      missedCount: 0,
      latestDueExecution: null,
    });

    const result = await checkSharedTemporalHealth();

    expect(result).toMatchObject({
      status: "unhealthy",
      reason: "stale_execution",
      schedules: { dueCount: 1, terminalCount: 0 },
    });
    expect(mocks.lastSuccessSet).not.toHaveBeenCalled();
  });

  it("adds missing repo-spec and defineScheduledJob declarations to the proof", async () => {
    mocks.rows.length = 0;
    mocks.nodeDeclarations.push({
      id: "repo-probe",
      nodeId: "node-123",
      cron: "*/5 * * * *",
      timezone: "UTC",
      kind: "graph",
      graph: "langgraph:probe",
      payload: { prompt: "probe" },
    });
    mocks.governanceDeclarations.push({
      charter: "COMMUNITY",
      cron: "0 * * * *",
      timezone: "UTC",
      entrypoint: "COMMUNITY",
    });
    mocks.jobDeclarations.push({
      id: "metrics-ingest",
      cron: "*/15 * * * *",
    });

    await checkSharedTemporalHealth();

    const call = mocks.inspectSchedules.mock.calls.at(-1)?.[0];
    expect(call.expectedSchedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          temporalScheduleId: "node-task:node-123:repo-probe",
          cron: "*/5 * * * *",
        }),
        expect.objectContaining({
          temporalScheduleId: "governance:community",
          cron: "0 * * * *",
        }),
        expect.objectContaining({
          temporalScheduleId: "missing:scheduled-job:metrics-ingest",
          cron: "*/15 * * * *",
        }),
      ])
    );
  });
});
