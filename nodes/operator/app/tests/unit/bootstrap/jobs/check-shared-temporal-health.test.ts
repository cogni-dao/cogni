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
  counterInc: vi.fn(),
  durationObserve: vi.fn(),
  lastSuccessSet: vi.fn(),
  pollerSet: vi.fn(),
}));

vi.mock("@/adapters/server/temporal", () => ({
  inspectSharedTemporalHealth: (...args: unknown[]) => mocks.inspect(...args),
}));

vi.mock("@/shared/config", () => ({ getNodeId: () => "node-123" }));

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
    vi.stubEnv("npm_package_version", "unknown");
    vi.stubEnv("BUILD_TIME", "2026-10-11T11:00:00.000Z");
    mocks.inspect.mockResolvedValue({
      status: "healthy",
      reason: "ok",
      durationMs: 42,
      pollers: { workflow: { status: "fresh" }, activity: { status: "fresh" } },
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
    expect(mocks.counterInc).toHaveBeenCalledOnce();
    expect(mocks.durationObserve).toHaveBeenCalledWith(42);
    expect(mocks.pollerSet).toHaveBeenCalledTimes(2);
    expect(mocks.lastSuccessSet).toHaveBeenCalledOnce();
  });
});
