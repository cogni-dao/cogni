// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/ai.runs.list`
 * Purpose: Contract tests for GET /api/v1/ai/runs — run list endpoint.
 * Scope: Verifies auth enforcement, user scoping, filtering, pagination, and response shape.
 * Invariants: Users see only their own runs; contract shape matches RunCardData
 * Side-effects: none (all I/O mocked)
 * Links: ai.runs.v1.contract, GraphRunRepository
 * @internal
 */

import type { GraphRun } from "@cogni/scheduler-core";
import { TEST_SESSION_USER_1, TEST_USER_ID_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as appHandler from "@/app/api/v1/ai/runs/route";

// --- Test data ---

function makeRun(overrides: Partial<GraphRun> = {}): GraphRun {
  return {
    id: "pk-1",
    scheduleId: null,
    runId: "run-1",
    graphId: "langgraph:default",
    runKind: "user_immediate",
    triggerSource: "api",
    triggerRef: null,
    requestedBy: TEST_USER_ID_1,
    scheduledFor: null,
    startedAt: new Date("2026-03-19T10:00:00Z"),
    completedAt: new Date("2026-03-19T10:00:05Z"),
    status: "success",
    attemptCount: 0,
    langfuseTraceId: null,
    errorCode: null,
    errorMessage: null,
    stateKey: "sk-abc",
    ...overrides,
  };
}

// --- Mocks ---

const mockListRunsByUser = vi.fn();
const mockGraphRunRepository = {
  createRun: vi.fn(),
  markRunStarted: vi.fn(),
  markRunCompleted: vi.fn(),
  getRunByRunId: vi.fn(),
  listRunsByUser: mockListRunsByUser,
};

vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log: {
      child: vi.fn(() => ({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      })),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    clock: { now: vi.fn(() => new Date("2025-01-01T00:00:00Z")) },
    config: { unhandledErrorPolicy: "rethrow" },
    graphRunRepository: mockGraphRunRepository,
  })),
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue(TEST_SESSION_USER_1),
}));

// --- Tests ---

describe("GET /api/v1/ai/runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with runs for authenticated user", async () => {
    const runs = [makeRun(), makeRun({ id: "pk-2", runId: "run-2" })];
    mockListRunsByUser.mockResolvedValue(runs);

    await testApiHandler({
      appHandler,
      url: "/api/v1/ai/runs",
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.runs).toHaveLength(2);
        expect(body.runs[0].runId).toBe("run-1");
        expect(body.runs[0].statusLabel).toBeNull();
        expect(body.runs[0].stateKey).toBe("sk-abc");
        expect(body.runs[0].startedAt).toBe("2026-03-19T10:00:00.000Z");
      },
    });
  });

  it("passes query params to port method", async () => {
    mockListRunsByUser.mockResolvedValue([]);

    await testApiHandler({
      appHandler,
      url: "/api/v1/ai/runs?status=running&runKind=user_immediate&limit=10",
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(200);

        expect(mockListRunsByUser).toHaveBeenCalledWith(
          expect.anything(), // actorId
          TEST_SESSION_USER_1.id,
          {
            status: "running",
            runKind: "user_immediate",
            limit: 10,
            cursor: undefined,
          }
        );
      },
    });
  });

  it("returns nextCursor when more results available", async () => {
    // Default limit is 20, adapter fetches 21. If we get 21, there's a next page.
    // For this test, use limit=2, so adapter returns 3 rows.
    const runs = [
      makeRun({
        id: "pk-1",
        runId: "r-1",
        startedAt: new Date("2026-03-19T10:00:00Z"),
      }),
      makeRun({
        id: "pk-2",
        runId: "r-2",
        startedAt: new Date("2026-03-19T09:00:00Z"),
      }),
      makeRun({
        id: "pk-3",
        runId: "r-3",
        startedAt: new Date("2026-03-19T08:00:00Z"),
      }),
    ];
    mockListRunsByUser.mockResolvedValue(runs);

    await testApiHandler({
      appHandler,
      url: "/api/v1/ai/runs?limit=2",
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.runs).toHaveLength(2);
        expect(body.nextCursor).toBe("2026-03-19T09:00:00.000Z");
      },
    });
  });

  it("omits nextCursor when no more results", async () => {
    mockListRunsByUser.mockResolvedValue([makeRun()]);

    await testApiHandler({
      appHandler,
      url: "/api/v1/ai/runs?limit=10",
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        const body = await res.json();
        expect(body.nextCursor).toBeUndefined();
      },
    });
  });

  it("returns 400 for invalid status value", async () => {
    await testApiHandler({
      appHandler,
      url: "/api/v1/ai/runs?status=invalid_status",
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(400);
      },
    });
  });

  it("returns empty array when no runs exist", async () => {
    mockListRunsByUser.mockResolvedValue([]);

    await testApiHandler({
      appHandler,
      url: "/api/v1/ai/runs",
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.runs).toEqual([]);
        expect(body.nextCursor).toBeUndefined();
      },
    });
  });

  it("uses Cache-Control: no-store", async () => {
    mockListRunsByUser.mockResolvedValue([]);

    await testApiHandler({
      appHandler,
      url: "/api/v1/ai/runs",
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.headers.get("cache-control")).toBe("no-store");
      },
    });
  });
});
