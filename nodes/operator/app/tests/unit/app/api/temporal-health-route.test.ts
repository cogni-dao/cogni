// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/temporal-health-route`
 * Purpose: Prove authenticated HTTP status and one terminal health event semantics.
 * Scope: Route orchestration with the diagnostic job mocked; no network IO.
 * Invariants: Healthy=200, unhealthy=503, no-store, HTTP IDs redacted, one correlated terminal event.
 * Side-effects: none
 * Links: task.5238
 * @internal
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  options: null as unknown,
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

vi.mock("@/bootstrap/jobs/checkSharedTemporalHealth.job", () => ({
  checkSharedTemporalHealth: (...args: unknown[]) => mocks.check(...args),
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (
    options: unknown,
    handler: (
      ctx: {
        log: {
          error: ReturnType<typeof vi.fn>;
          info: ReturnType<typeof vi.fn>;
        };
      },
      request: NextRequest,
      sessionUser: { id: string }
    ) => Promise<Response>
  ) => {
    mocks.options = options;
    return (request: NextRequest) =>
      handler({ log: { error: mocks.error, info: mocks.info } }, request, {
        id: "developer-1",
      });
  },
}));

import { GET } from "@/app/api/v1/temporal/health/route";

const healthy = {
  status: "healthy",
  reason: "ok",
  mode: "compatibility",
  nodeId: "node-123",
  namespace: "cogni-production",
  taskQueue: "scheduler-tasks-node-123",
  app: {
    version: "0.1.0",
    buildSha: "a".repeat(40),
    buildTime: null,
  },
  worker: {
    service: "scheduler-worker",
    sha: "b".repeat(40),
    buildTs: null,
    imageDigest: `sha256:${"c".repeat(64)}`,
  },
  pollers: {
    workflow: {
      status: "fresh",
      pollerCount: 1,
      freshestLastAccessAt: "2026-10-11T12:00:00.000Z",
      freshestAgeMs: 1_000,
    },
    activity: {
      status: "fresh",
      pollerCount: 1,
      freshestLastAccessAt: "2026-10-11T12:00:00.000Z",
      freshestAgeMs: 1_000,
    },
  },
  schedules: {
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
    latestDueExecution: {
      scheduledAt: "2026-10-11T11:55:00.000Z",
      workflowId: "workflow-1",
      firstExecutionRunId: "run-1",
      status: "COMPLETED",
    },
  },
  checkedAt: "2026-10-11T12:00:01.000Z",
  durationMs: 42,
};

describe("GET /api/v1/temporal/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns redacted healthy proof while the terminal event keeps correlation", async () => {
    mocks.check.mockResolvedValue(healthy);

    const response = await GET(
      new NextRequest("http://localhost/api/v1/temporal/health")
    );

    expect(mocks.options).toMatchObject({
      routeId: "temporal.health",
      auth: { mode: "required" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ...healthy,
      schedules: {
        ...healthy.schedules,
        latestDueExecution: {
          ...healthy.schedules.latestDueExecution,
          workflowId: null,
          firstExecutionRunId: null,
        },
      },
    });
    expect(mocks.info).toHaveBeenCalledOnce();
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.temporal.health_checked",
        outcome: "success",
        reasonCode: "ok",
        mode: "compatibility",
        appBuildSha: "a".repeat(40),
        workerImageDigest: `sha256:${"c".repeat(64)}`,
        scheduleDriftCount: 0,
        dueExecutionCount: 1,
        terminalExecutionCount: 1,
        failedExecutionCount: 0,
        staleExecutionCount: 0,
        missedExecutionCount: 0,
        latestDueWorkflowId: "workflow-1",
        latestDueWorkflowRunId: "run-1",
        latestDueWorkflowStatus: "COMPLETED",
      }),
      "shared Temporal substrate health check complete"
    );
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("returns 503 and exactly one error event for failed proof", async () => {
    mocks.check.mockResolvedValue({
      ...healthy,
      status: "unhealthy",
      reason: "activity_poller_stale",
      pollers: {
        ...healthy.pollers,
        activity: { ...healthy.pollers.activity, status: "stale" },
      },
    });

    const response = await GET(
      new NextRequest("http://localhost/api/v1/temporal/health")
    );

    expect(response.status).toBe(503);
    expect(mocks.error).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "substrate.temporal.health_checked",
        outcome: "error",
        reasonCode: "activity_poller_stale",
      }),
      "shared Temporal substrate health check failed"
    );
    expect(mocks.info).not.toHaveBeenCalled();
  });
});
