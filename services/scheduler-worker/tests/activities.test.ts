// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/activities.test`
 * Purpose: Unit tests for scheduler-worker activities.
 * Scope: Tests activity creation and basic behavior with mocked deps.
 * Note: Full integration testing done via stack tests.
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @temporalio/activity before importing activities
vi.mock("@temporalio/activity", () => ({
  ApplicationFailure: {
    nonRetryable: (message: string, type?: string, details?: unknown) => {
      const error = new Error(message);
      (error as { type?: string }).type = type;
      (error as { details?: unknown }).details = details;
      (error as { nonRetryable?: boolean }).nonRetryable = true;
      return error;
    },
    retryable: (message: string, type?: string, details?: unknown) => {
      const error = new Error(message);
      (error as { type?: string }).type = type;
      (error as { details?: unknown }).details = details;
      (error as { nonRetryable?: boolean }).nonRetryable = false;
      return error;
    },
  },
  activityInfo: () => ({
    attempt: 1,
    workflowExecution: {
      workflowId: "test-workflow-id",
      runId: "test-temporal-run-id",
    },
  }),
}));

import { SYSTEM_ACTOR } from "@cogni/ids/system";

import { createActivities } from "../src/activities/index.js";
import {
  createMockApiErrorResponse,
  createMockApiSuccessResponse,
  createMockGrant,
  FIXED_IDS,
} from "./fixtures.js";

const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();
const loggerDebug = vi.fn();

// Mock logger
const mockLogger = {
  info: loggerInfo,
  warn: loggerWarn,
  error: loggerError,
  debug: loggerDebug,
  child: () => mockLogger,
} as unknown as Parameters<typeof createActivities>[0]["logger"];

// Fail-closed per-node principal resolver mock (G1, task.5029). The graph-path
// activities under test never call it; node-task dispatch tests override it.
const mockNodePrincipalResolver = {
  resolve: vi.fn(),
} as unknown as Parameters<typeof createActivities>[0]["nodePrincipalResolver"];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createActivities", () => {
  it("returns all expected activity functions", () => {
    const mockGrantAdapter = {
      validateGrantForGraph: vi.fn(),
    } as unknown as Parameters<typeof createActivities>[0]["grantAdapter"];
    const mockRunAdapter = {
      createRun: vi.fn(),
      markRunStarted: vi.fn(),
      markRunCompleted: vi.fn(),
    } as unknown as Parameters<typeof createActivities>[0]["runAdapter"];

    const activities = createActivities({
      grantAdapter: mockGrantAdapter,
      runAdapter: mockRunAdapter,
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    expect(activities).toHaveProperty("validateGrantActivity");
    expect(activities).toHaveProperty("createGraphRunActivity");
    expect(activities).toHaveProperty("executeGraphActivity");
    expect(activities).toHaveProperty("updateGraphRunActivity");

    expect(typeof activities.validateGrantActivity).toBe("function");
    expect(typeof activities.createGraphRunActivity).toBe("function");
    expect(typeof activities.executeGraphActivity).toBe("function");
    expect(typeof activities.updateGraphRunActivity).toBe("function");
  });
});

describe("validateGrantActivity", () => {
  it("calls grantAdapter.validateGrantForGraph with correct args", async () => {
    const mockGrantAdapter = {
      validateGrantForGraph: vi.fn().mockResolvedValue(createMockGrant()),
    } as unknown as Parameters<typeof createActivities>[0]["grantAdapter"];

    const activities = createActivities({
      grantAdapter: mockGrantAdapter,
      runAdapter: {} as Parameters<typeof createActivities>[0]["runAdapter"],
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    await activities.validateGrantActivity({
      nodeId: "operator",
      grantId: FIXED_IDS.grantId,
      graphId: FIXED_IDS.graphId,
    });

    expect(mockGrantAdapter.validateGrantForGraph).toHaveBeenCalledWith(
      SYSTEM_ACTOR,
      "operator",
      FIXED_IDS.grantId,
      FIXED_IDS.graphId
    );
  });

  it("throws when grant validation fails", async () => {
    const mockGrantAdapter = {
      validateGrantForGraph: vi
        .fn()
        .mockRejectedValue(new Error("Grant expired")),
    } as unknown as Parameters<typeof createActivities>[0]["grantAdapter"];

    const activities = createActivities({
      grantAdapter: mockGrantAdapter,
      runAdapter: {} as Parameters<typeof createActivities>[0]["runAdapter"],
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    await expect(
      activities.validateGrantActivity({
        nodeId: "operator",
        grantId: FIXED_IDS.grantId,
        graphId: FIXED_IDS.graphId,
      })
    ).rejects.toThrow("Grant expired");
  });
});

describe("createGraphRunActivity", () => {
  it("calls runAdapter.createRun with correct args", async () => {
    const mockRunAdapter = {
      createRun: vi.fn().mockResolvedValue(undefined),
      markRunStarted: vi.fn(),
      markRunCompleted: vi.fn(),
    } as unknown as Parameters<typeof createActivities>[0]["runAdapter"];

    const activities = createActivities({
      grantAdapter: {} as Parameters<
        typeof createActivities
      >[0]["grantAdapter"],
      runAdapter: mockRunAdapter,
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    const scheduledFor = "2025-01-15T10:00:00.000Z";

    await activities.createGraphRunActivity({
      nodeId: "operator",
      dbScheduleId: FIXED_IDS.scheduleId,
      runId: FIXED_IDS.runId,
      scheduledFor,
      graphId: FIXED_IDS.graphId,
      runKind: "system_scheduled",
      triggerSource: "temporal_schedule",
    });

    expect(mockRunAdapter.createRun).toHaveBeenCalledWith(
      SYSTEM_ACTOR,
      "operator",
      {
        runId: FIXED_IDS.runId,
        graphId: FIXED_IDS.graphId,
        runKind: "system_scheduled",
        triggerSource: "temporal_schedule",
        scheduleId: FIXED_IDS.scheduleId,
        scheduledFor: new Date(scheduledFor),
      }
    );
  });
});

describe("updateGraphRunActivity", () => {
  it("calls markRunStarted for running status", async () => {
    const mockRunAdapter = {
      createRun: vi.fn(),
      markRunStarted: vi.fn().mockResolvedValue(undefined),
      markRunCompleted: vi.fn(),
    } as unknown as Parameters<typeof createActivities>[0]["runAdapter"];

    const activities = createActivities({
      grantAdapter: {} as Parameters<
        typeof createActivities
      >[0]["grantAdapter"],
      runAdapter: mockRunAdapter,
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    await activities.updateGraphRunActivity({
      nodeId: "operator",
      runId: FIXED_IDS.runId,
      status: "running",
      traceId: "trace-123",
    });

    expect(mockRunAdapter.markRunStarted).toHaveBeenCalledWith(
      SYSTEM_ACTOR,
      "operator",
      FIXED_IDS.runId,
      "trace-123"
    );
  });

  it("calls markRunCompleted for success status", async () => {
    const mockRunAdapter = {
      createRun: vi.fn(),
      markRunStarted: vi.fn(),
      markRunCompleted: vi.fn().mockResolvedValue(undefined),
    } as unknown as Parameters<typeof createActivities>[0]["runAdapter"];

    const activities = createActivities({
      grantAdapter: {} as Parameters<
        typeof createActivities
      >[0]["grantAdapter"],
      runAdapter: mockRunAdapter,
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    await activities.updateGraphRunActivity({
      nodeId: "operator",
      runId: FIXED_IDS.runId,
      status: "success",
    });

    expect(mockRunAdapter.markRunCompleted).toHaveBeenCalledWith(
      SYSTEM_ACTOR,
      "operator",
      FIXED_IDS.runId,
      "success",
      undefined,
      undefined
    );
  });

  it("calls markRunCompleted for error status with message", async () => {
    const mockRunAdapter = {
      createRun: vi.fn(),
      markRunStarted: vi.fn(),
      markRunCompleted: vi.fn().mockResolvedValue(undefined),
    } as unknown as Parameters<typeof createActivities>[0]["runAdapter"];

    const activities = createActivities({
      grantAdapter: {} as Parameters<
        typeof createActivities
      >[0]["grantAdapter"],
      runAdapter: mockRunAdapter,
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    await activities.updateGraphRunActivity({
      nodeId: "operator",
      runId: FIXED_IDS.runId,
      status: "error",
      errorMessage: "Something went wrong",
    });

    expect(mockRunAdapter.markRunCompleted).toHaveBeenCalledWith(
      SYSTEM_ACTOR,
      "operator",
      FIXED_IDS.runId,
      "error",
      "Something went wrong",
      undefined
    );
  });
});

describe("HTTP error translation (task.0280 phase 2)", () => {
  it("validateGrantActivity wraps GrantExpiredError as nonRetryable", async () => {
    const { GrantExpiredError } = await import("../src/ports/index.js");
    const mockGrantAdapter = {
      validateGrantForGraph: vi
        .fn()
        .mockRejectedValue(new GrantExpiredError("g-1")),
    } as unknown as Parameters<typeof createActivities>[0]["grantAdapter"];

    const activities = createActivities({
      grantAdapter: mockGrantAdapter,
      runAdapter: {} as Parameters<typeof createActivities>[0]["runAdapter"],
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    await expect(
      activities.validateGrantActivity({
        nodeId: "operator",
        grantId: FIXED_IDS.grantId,
        graphId: FIXED_IDS.graphId,
      })
    ).rejects.toMatchObject({ type: "grant_expired" });
  });

  it("createGraphRunActivity wraps non-retryable RunHttpClientError as nonRetryable", async () => {
    const { RunHttpClientError } = await import("../src/ports/index.js");
    const mockRunAdapter = {
      createRun: vi
        .fn()
        .mockRejectedValue(new RunHttpClientError("bad", 400, false)),
      markRunStarted: vi.fn(),
      markRunCompleted: vi.fn(),
    } as unknown as Parameters<typeof createActivities>[0]["runAdapter"];

    const activities = createActivities({
      grantAdapter: {} as Parameters<
        typeof createActivities
      >[0]["grantAdapter"],
      runAdapter: mockRunAdapter,
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    await expect(
      activities.createGraphRunActivity({
        nodeId: "operator",
        runId: FIXED_IDS.runId,
      })
    ).rejects.toMatchObject({ type: "HttpClientError" });
  });

  it("createGraphRunActivity lets retryable RunHttpClientError bubble for Temporal retry", async () => {
    const { RunHttpClientError } = await import("../src/ports/index.js");
    const mockRunAdapter = {
      createRun: vi
        .fn()
        .mockRejectedValue(new RunHttpClientError("boom", 503, true)),
      markRunStarted: vi.fn(),
      markRunCompleted: vi.fn(),
    } as unknown as Parameters<typeof createActivities>[0]["runAdapter"];

    const activities = createActivities({
      grantAdapter: {} as Parameters<
        typeof createActivities
      >[0]["grantAdapter"],
      runAdapter: mockRunAdapter,
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    await expect(
      activities.createGraphRunActivity({
        nodeId: "operator",
        runId: FIXED_IDS.runId,
      })
    ).rejects.toMatchObject({ name: "RunHttpClientError", retryable: true });
  });
});

describe("executeGraphActivity", () => {
  it("calls internal API with correct headers and body", async () => {
    const mockResponse = createMockApiSuccessResponse();

    // Mock global fetch
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });
    vi.stubGlobal("fetch", mockFetch);

    const activities = createActivities({
      grantAdapter: {} as Parameters<
        typeof createActivities
      >[0]["grantAdapter"],
      runAdapter: {} as Parameters<typeof createActivities>[0]["runAdapter"],
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    const result = await activities.executeGraphActivity({
      nodeId: "operator",
      temporalScheduleId: FIXED_IDS.scheduleId,
      graphId: FIXED_IDS.graphId,
      executionGrantId: FIXED_IDS.grantId,
      input: { messages: [], model: "gpt-4o-mini" },
      scheduledFor: "2025-01-15T10:00:00.000Z",
      runId: FIXED_IDS.runId,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      `http://localhost:3000/api/internal/graphs/${FIXED_IDS.graphId}/runs`,
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token-min-32-characters-long",
          "Idempotency-Key": `${FIXED_IDS.scheduleId}:2025-01-15T10:00:00.000Z`,
        },
        body: JSON.stringify({
          executionGrantId: FIXED_IDS.grantId,
          input: { messages: [], model: "gpt-4o-mini" },
          runId: FIXED_IDS.runId,
        }),
      })
    );

    expect(result).toEqual(mockResponse);

    vi.unstubAllGlobals();
  });

  it.each([
    404, 408, 409, 429, 520,
  ])("classifies HTTP %i as retryable transport uncertainty", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("proxy body must not be logged", { status })
        )
    );

    const activities = createActivities({
      grantAdapter: {} as Parameters<
        typeof createActivities
      >[0]["grantAdapter"],
      runAdapter: {} as Parameters<typeof createActivities>[0]["runAdapter"],
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    await expect(
      activities.executeGraphActivity({
        nodeId: "operator",
        temporalScheduleId: FIXED_IDS.scheduleId,
        graphId: FIXED_IDS.graphId,
        executionGrantId: FIXED_IDS.grantId,
        input: {},
        scheduledFor: "2025-01-15T10:00:00.000Z",
        runId: FIXED_IDS.runId,
      })
    ).rejects.toMatchObject({
      type: status === 409 ? "GRAPH_EXECUTION_PENDING" : "GRAPH_TRANSPORT_HTTP",
      nonRetryable: false,
    });

    const expectedLogger = status === 409 ? loggerInfo : loggerWarn;
    expect(expectedLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        activityAttempt: 1,
        httpStatus: status,
        retryable: true,
      }),
      status === 409
        ? "worker.activity.graph_pending"
        : "worker.activity.graph_error"
    );
    expect(JSON.stringify(expectedLogger.mock.calls)).not.toContain(
      "proxy body must not be logged"
    );

    vi.unstubAllGlobals();
  });

  it.each([
    400, 401, 403, 422,
  ])("classifies HTTP %i as a permanent rejection", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("sensitive rejection body", { status }))
    );

    const activities = createActivities({
      grantAdapter: {} as Parameters<
        typeof createActivities
      >[0]["grantAdapter"],
      runAdapter: {} as Parameters<typeof createActivities>[0]["runAdapter"],
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    await expect(
      activities.executeGraphActivity({
        nodeId: "operator",
        temporalScheduleId: FIXED_IDS.scheduleId,
        graphId: FIXED_IDS.graphId,
        executionGrantId: FIXED_IDS.grantId,
        input: {},
        scheduledFor: "2025-01-15T10:00:00.000Z",
        runId: FIXED_IDS.runId,
      })
    ).rejects.toMatchObject({
      type: "GRAPH_REQUEST_REJECTED",
      nonRetryable: true,
    });

    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        httpStatus: status,
        retryable: false,
      }),
      "worker.activity.graph_error"
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      "sensitive rejection body"
    );

    vi.unstubAllGlobals();
  });

  it("classifies a fetch rejection as retryable transport uncertainty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("socket reset"))
    );

    const activities = createActivities({
      grantAdapter: {} as Parameters<
        typeof createActivities
      >[0]["grantAdapter"],
      runAdapter: {} as Parameters<typeof createActivities>[0]["runAdapter"],
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    await expect(
      activities.executeGraphActivity({
        nodeId: "operator",
        temporalScheduleId: FIXED_IDS.scheduleId,
        graphId: FIXED_IDS.graphId,
        executionGrantId: FIXED_IDS.grantId,
        input: {},
        scheduledFor: "2025-01-15T10:00:00.000Z",
        runId: FIXED_IDS.runId,
      })
    ).rejects.toMatchObject({
      type: "GRAPH_TRANSPORT_NETWORK",
      nonRetryable: false,
    });
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain("socket reset");

    vi.unstubAllGlobals();
  });

  it("retries a malformed HTTP 200 instead of accepting a false terminal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, runId: FIXED_IDS.runId }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const activities = createActivities({
      grantAdapter: {} as Parameters<
        typeof createActivities
      >[0]["grantAdapter"],
      runAdapter: {} as Parameters<typeof createActivities>[0]["runAdapter"],
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    await expect(
      activities.executeGraphActivity({
        nodeId: "operator",
        temporalScheduleId: FIXED_IDS.scheduleId,
        graphId: FIXED_IDS.graphId,
        executionGrantId: FIXED_IDS.grantId,
        input: {},
        scheduledFor: "2025-01-15T10:00:00.000Z",
        runId: FIXED_IDS.runId,
      })
    ).rejects.toMatchObject({
      type: "GRAPH_RESPONSE_INVALID",
      nonRetryable: false,
    });

    vi.unstubAllGlobals();
  });

  it("normalizes a definitive graph error from the wire contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(createMockApiErrorResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const activities = createActivities({
      grantAdapter: {} as Parameters<
        typeof createActivities
      >[0]["grantAdapter"],
      runAdapter: {} as Parameters<typeof createActivities>[0]["runAdapter"],
      nodePrincipalResolver: mockNodePrincipalResolver,
      config: {
        nodeEndpoints: new Map([["operator", "http://localhost:3000"]]),
        schedulerApiToken: "test-token-min-32-characters-long",
      },
      logger: mockLogger,
    });

    await expect(
      activities.executeGraphActivity({
        nodeId: "operator",
        temporalScheduleId: FIXED_IDS.scheduleId,
        graphId: FIXED_IDS.graphId,
        executionGrantId: FIXED_IDS.grantId,
        input: {},
        scheduledFor: "2025-01-15T10:00:00.000Z",
        runId: FIXED_IDS.runId,
      })
    ).resolves.toMatchObject({ ok: false, errorCode: "internal" });

    vi.unstubAllGlobals();
  });
});
