// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/temporal/shared-temporal-health`
 * Purpose: Prove fail-closed shared Temporal artifact and poller diagnostics.
 * Scope: Pure/injected unit coverage; no network or Temporal server.
 * Invariants: Both task types are server-observed and <=120s fresh; invalid identity never passes.
 * Side-effects: none
 * Links: task.5238
 * @internal
 */

import { describe, expect, it, vi } from "vitest";
import {
  assessPollers,
  inspectSharedTemporalHealth,
  parseWorkerIdentity,
  TEMPORAL_POLLER_MAX_AGE_MS,
  workerPollerIdentity,
} from "@/adapters/server/temporal";

const NOW_MS = Date.parse("2026-10-11T12:00:00.000Z");
const APP_SHA = "a".repeat(40);
const WORKER_SHA = "b".repeat(40);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;

const config = {
  nodeId: "node-123",
  temporalAddress: "temporal:7233",
  namespace: "cogni-production",
  taskQueue: "scheduler-tasks-node-123",
  schedulerWorkerHealthUrl: "http://scheduler-worker:9000",
  app: {
    version: "0.1.0",
    buildSha: APP_SHA,
    buildTime: "2026-10-11T11:00:00.000Z",
  },
} as const;

function timestamp(ms: number) {
  return {
    seconds: Math.floor(ms / 1_000),
    nanos: (ms % 1_000) * 1_000_000,
  };
}

function workerResponse(body: unknown = validWorkerIdentity()): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function validWorkerIdentity() {
  return {
    service: "scheduler-worker",
    sha: WORKER_SHA,
    buildTs: "2026-10-11T11:00:00.000Z",
    imageDigest: IMAGE_DIGEST,
  };
}

function healthyDeps(overrides: Record<string, unknown> = {}) {
  const describeTaskQueue = vi.fn().mockResolvedValue({
    pollers: [
      {
        identity: workerPollerIdentity(validWorkerIdentity()),
        lastAccessTime: timestamp(NOW_MS - 1_000),
      },
    ],
  });
  const close = vi.fn().mockResolvedValue(undefined);
  const connect = vi.fn().mockResolvedValue({
    workflowService: { describeTaskQueue },
    withDeadline: (_deadline: number | Date, fn: () => Promise<unknown>) =>
      fn(),
    close,
  });
  return {
    now: () => NOW_MS,
    fetch: vi.fn().mockResolvedValue(workerResponse()),
    connect,
    describeTaskQueue,
    close,
    ...overrides,
  };
}

describe("shared Temporal health adapter", () => {
  it("reports healthy only after server-observing both fresh task types", async () => {
    const deps = healthyDeps();

    const result = await inspectSharedTemporalHealth(config, deps);

    expect(result).toMatchObject({
      status: "healthy",
      reason: "ok",
      nodeId: "node-123",
      namespace: "cogni-production",
      taskQueue: "scheduler-tasks-node-123",
      app: config.app,
      worker: validWorkerIdentity(),
      pollers: {
        workflow: { status: "fresh", pollerCount: 1 },
        activity: { status: "fresh", pollerCount: 1 },
      },
    });
    expect(deps.describeTaskQueue).toHaveBeenCalledTimes(2);
    expect(
      deps.describeTaskQueue.mock.calls.map(([request]) => request)
    ).toEqual(
      expect.arrayContaining([
        {
          namespace: "cogni-production",
          taskQueue: { name: "scheduler-tasks-node-123" },
          taskQueueType: 1,
        },
        {
          namespace: "cogni-production",
          taskQueue: { name: "scheduler-tasks-node-123" },
          taskQueueType: 2,
        },
      ])
    );
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it("rejects placeholder app identity before network IO", async () => {
    const deps = healthyDeps();
    const result = await inspectSharedTemporalHealth(
      { ...config, app: { ...config.app, buildSha: "unknown" } },
      deps
    );

    expect(result.reason).toBe("app_identity_invalid");
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("accepts canonical /version output when version is unknown but SHA is exact", async () => {
    const result = await inspectSharedTemporalHealth(
      { ...config, app: { ...config.app, version: "unknown" } },
      healthyDeps()
    );

    expect(result).toMatchObject({
      status: "healthy",
      app: { version: "unknown", buildSha: APP_SHA },
    });
  });

  it.each([
    ["missing", [], "workflow_poller_missing"],
    ["malformed", [{}], "workflow_poller_malformed"],
    [
      "stale",
      [{ lastAccessTime: timestamp(NOW_MS - TEMPORAL_POLLER_MAX_AGE_MS - 1) }],
      "workflow_poller_stale",
    ],
  ])("fails closed for %s workflow pollers", async (_name, pollers, reason) => {
    const deps = healthyDeps();
    deps.describeTaskQueue.mockImplementation(({ taskQueueType }) =>
      Promise.resolve({
        pollers:
          taskQueueType === 1
            ? pollers
            : [
                {
                  identity: workerPollerIdentity(validWorkerIdentity()),
                  lastAccessTime: timestamp(NOW_MS),
                },
              ],
      })
    );

    const result = await inspectSharedTemporalHealth(config, deps);

    expect(result).toMatchObject({ status: "unhealthy", reason });
  });

  it("fails closed when the Activity poller is stale", async () => {
    const deps = healthyDeps();
    deps.describeTaskQueue.mockImplementation(({ taskQueueType }) =>
      Promise.resolve({
        pollers: [
          {
            identity: workerPollerIdentity(validWorkerIdentity()),
            lastAccessTime: timestamp(
              taskQueueType === 2
                ? NOW_MS - TEMPORAL_POLLER_MAX_AGE_MS - 1
                : NOW_MS
            ),
          },
        ],
      })
    );

    const result = await inspectSharedTemporalHealth(config, deps);

    expect(result.reason).toBe("activity_poller_stale");
  });

  it("treats the 120-second freshness boundary as healthy", () => {
    expect(
      assessPollers(
        [
          {
            lastAccessTime: timestamp(NOW_MS - TEMPORAL_POLLER_MAX_AGE_MS),
          },
        ],
        NOW_MS
      ).status
    ).toBe("fresh");
  });

  it("uses the newest poller and retains the server-observed count", () => {
    expect(
      assessPollers(
        [
          { lastAccessTime: timestamp(NOW_MS - 300_000) },
          { lastAccessTime: timestamp(NOW_MS - 2_000) },
        ],
        NOW_MS
      )
    ).toMatchObject({ status: "fresh", pollerCount: 2, freshestAgeMs: 2_000 });
  });

  it("fails closed when any returned poller timestamp is malformed", () => {
    expect(
      assessPollers([{ lastAccessTime: timestamp(NOW_MS - 1_000) }, {}], NOW_MS)
        .status
    ).toBe("malformed");
  });

  it("distinguishes an unreachable worker from invalid artifact identity", async () => {
    const unreachable = healthyDeps({
      fetch: vi.fn().mockRejectedValue(new Error("connection refused")),
    });
    const invalid = healthyDeps({
      fetch: vi.fn().mockResolvedValue(
        workerResponse({
          ...validWorkerIdentity(),
          imageDigest: "placeholder",
        })
      ),
    });

    await expect(
      inspectSharedTemporalHealth(config, unreachable)
    ).resolves.toMatchObject({ reason: "worker_unreachable", worker: null });
    await expect(
      inspectSharedTemporalHealth(config, invalid)
    ).resolves.toMatchObject({
      reason: "worker_identity_invalid",
      worker: null,
    });
  });

  it("reports Temporal unavailable and still closes a connected client", async () => {
    const deps = healthyDeps();
    deps.describeTaskQueue.mockRejectedValue(new Error("deadline exceeded"));

    const result = await inspectSharedTemporalHealth(config, deps);

    expect(result.reason).toBe("temporal_unavailable");
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it("fails closed when fresh Workflow and Activity pollers report mixed artifacts", async () => {
    const deps = healthyDeps();
    deps.describeTaskQueue.mockImplementation(({ taskQueueType }) =>
      Promise.resolve({
        pollers: [
          {
            identity:
              taskQueueType === 1
                ? workerPollerIdentity(validWorkerIdentity())
                : `cogni:scheduler-worker:${"d".repeat(40)}:${IMAGE_DIGEST}`,
            lastAccessTime: timestamp(NOW_MS),
          },
        ],
      })
    );

    await expect(
      inspectSharedTemporalHealth(config, deps)
    ).resolves.toMatchObject({ reason: "worker_identity_mixed" });
  });
});

describe("scheduler-worker version identity", () => {
  it("accepts only an exact service, source SHA, and image digest", () => {
    expect(parseWorkerIdentity(validWorkerIdentity())).toEqual(
      validWorkerIdentity()
    );
    expect(
      parseWorkerIdentity({ ...validWorkerIdentity(), sha: "abc123" })
    ).toBeNull();
    expect(
      parseWorkerIdentity({ ...validWorkerIdentity(), service: "worker" })
    ).toBeNull();
    expect(
      parseWorkerIdentity({ ...validWorkerIdentity(), imageDigest: "unknown" })
    ).toBeNull();
  });
});
