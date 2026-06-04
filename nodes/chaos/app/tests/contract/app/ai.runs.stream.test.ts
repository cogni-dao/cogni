// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/ai.runs.stream`
 * Purpose: Contract tests for GET /api/v1/ai/runs/{runId}/stream SSE reconnection endpoint.
 * Scope: Verifies auth enforcement, ownership checks, 410 expired stream, and SSE wire format.
 * Invariants: SSE_FROM_REDIS_NOT_MEMORY — response streams from mocked RunStreamPort
 * Side-effects: none (all I/O mocked)
 * Links: runs.stream.v1.contract, RunStreamPort, GraphRunRepository
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import type {
  RunStreamEntry,
  RunStreamPort,
} from "@cogni/graph-execution-core";
import type { GraphRun } from "@cogni/scheduler-core";
import {
  TEST_SESSION_USER_1,
  TEST_SESSION_USER_2,
  TEST_USER_ID_1,
} from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as appHandler from "@/app/api/v1/ai/runs/[runId]/stream/route";

// --- Test data ---

const TEST_RUN_ID = "a0000000-0000-4000-a000-000000000001";

function makeRun(overrides: Partial<GraphRun> = {}): GraphRun {
  return {
    id: "pk-1",
    scheduleId: null,
    runId: TEST_RUN_ID,
    graphId: "langgraph:default",
    runKind: "user_immediate",
    triggerSource: "api",
    triggerRef: null,
    requestedBy: TEST_USER_ID_1,
    scheduledFor: null,
    startedAt: new Date(),
    completedAt: null,
    status: "running",
    attemptCount: 0,
    langfuseTraceId: null,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

function makeEntry(id: string, event: AiEvent): RunStreamEntry {
  return { id, event };
}

// --- Mocks ---

const mockGraphRunRepository = {
  createRun: vi.fn(),
  markRunStarted: vi.fn(),
  markRunCompleted: vi.fn(),
  getRunByRunId: vi.fn(),
};

const mockRunStream: RunStreamPort = {
  publish: vi.fn(),
  subscribe: vi.fn(),
  expire: vi.fn(),
  streamLength: vi.fn(),
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
    runStream: mockRunStream,
  })),
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue(TEST_SESSION_USER_1),
}));

// --- Tests ---

describe("GET /api/v1/ai/runs/{runId}/stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 for invalid runId (not UUID)", async () => {
    await testApiHandler({
      appHandler,
      params: { runId: "not-a-uuid" },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe("Invalid runId");
      },
    });
  });

  it("returns 404 when run does not exist", async () => {
    mockGraphRunRepository.getRunByRunId.mockResolvedValue(null);

    await testApiHandler({
      appHandler,
      params: { runId: TEST_RUN_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(404);
      },
    });
  });

  it("returns 403 when user does not own the run", async () => {
    mockGraphRunRepository.getRunByRunId.mockResolvedValue(
      makeRun({ requestedBy: TEST_SESSION_USER_2.id })
    );

    await testApiHandler({
      appHandler,
      params: { runId: TEST_RUN_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.error).toBe("Forbidden");
      },
    });
  });

  it("returns 410 when run is terminal and stream is expired", async () => {
    mockGraphRunRepository.getRunByRunId.mockResolvedValue(
      makeRun({ status: "success", completedAt: new Date() })
    );
    vi.mocked(mockRunStream.streamLength).mockResolvedValue(0);

    await testApiHandler({
      appHandler,
      params: { runId: TEST_RUN_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(410);
        const body = await res.json();
        expect(body.error).toBe("Stream expired");
      },
    });
  });

  it("streams SSE events from Redis subscription", async () => {
    mockGraphRunRepository.getRunByRunId.mockResolvedValue(makeRun());

    const events: RunStreamEntry[] = [
      makeEntry("1710000000000-0", { type: "text_delta", delta: "Hello" }),
      makeEntry("1710000000001-0", {
        type: "text_delta",
        delta: " world",
      }),
      makeEntry("1710000000002-0", { type: "done" }),
    ];

    vi.mocked(mockRunStream.subscribe).mockReturnValue(
      (async function* () {
        for (const e of events) yield e;
      })()
    );

    await testApiHandler({
      appHandler,
      params: { runId: TEST_RUN_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("text/event-stream");

        const body = await res.text();

        // Verify SSE format: id + event + data lines
        expect(body).toContain("id: 1710000000000-0");
        expect(body).toContain("event: text_delta");
        expect(body).toContain('data: {"type":"text_delta","delta":"Hello"}');
        expect(body).toContain("id: 1710000000002-0");
        expect(body).toContain("event: done");
      },
    });
  });

  it("filters out internal events (usage_report, assistant_final)", async () => {
    mockGraphRunRepository.getRunByRunId.mockResolvedValue(makeRun());

    const events: RunStreamEntry[] = [
      makeEntry("1-0", { type: "text_delta", delta: "Hi" }),
      makeEntry("2-0", {
        type: "usage_report",
        fact: {
          runId: TEST_RUN_ID,
          model: "test",
          promptTokens: 10,
          completionTokens: 5,
          callId: "call-1",
        },
      }),
      makeEntry("3-0", {
        type: "assistant_final",
        content: "Hi",
      }),
      makeEntry("4-0", { type: "done" }),
    ];

    vi.mocked(mockRunStream.subscribe).mockReturnValue(
      (async function* () {
        for (const e of events) yield e;
      })()
    );

    await testApiHandler({
      appHandler,
      params: { runId: TEST_RUN_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        const body = await res.text();

        // Internal events should be filtered
        expect(body).not.toContain("usage_report");
        expect(body).not.toContain("assistant_final");

        // Public events should be present
        expect(body).toContain("text_delta");
        expect(body).toContain("event: done");
      },
    });
  });

  it("passes Last-Event-ID to subscribe as fromId", async () => {
    mockGraphRunRepository.getRunByRunId.mockResolvedValue(makeRun());

    vi.mocked(mockRunStream.subscribe).mockReturnValue(
      (async function* () {
        yield makeEntry("5-0", { type: "done" });
      })()
    );

    await testApiHandler({
      appHandler,
      params: { runId: TEST_RUN_ID },
      async test({ fetch }) {
        const res = await fetch({
          method: "GET",
          headers: { "Last-Event-ID": "1710000000000-0" },
        });
        expect(res.status).toBe(200);

        // Verify subscribe was called with the correct fromId
        expect(mockRunStream.subscribe).toHaveBeenCalledWith(
          TEST_RUN_ID,
          expect.any(AbortSignal),
          "1710000000000-0"
        );
      },
    });
  });

  it("does not check streamLength for non-terminal runs", async () => {
    mockGraphRunRepository.getRunByRunId.mockResolvedValue(
      makeRun({ status: "running" })
    );

    vi.mocked(mockRunStream.subscribe).mockReturnValue(
      (async function* () {
        yield makeEntry("1-0", { type: "done" });
      })()
    );

    await testApiHandler({
      appHandler,
      params: { runId: TEST_RUN_ID },
      async test({ fetch }) {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(200);
        expect(mockRunStream.streamLength).not.toHaveBeenCalled();
      },
    });
  });
});
