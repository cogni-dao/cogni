// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/scripts/temporal-scheduled-probe`
 * Purpose: Prove the live scheduled-graph harness is bounded, correlated, and cleanup-safe.
 * Scope: Mocked HTTP/Loki dependencies only. Does not use network, database, Temporal, time, or RNG.
 * Invariants: Exact new-run diff, free-model payload, Loki correlation, and finally cleanup.
 * Side-effects: none
 * Links: scripts/lib/temporal-scheduled-probe.mjs, task.5239
 * @public
 */

import { describe, expect, it, vi } from "vitest";
import {
  cronForUtcMinute,
  proveScheduledLangGraph,
  proveScheduledLangGraphTargets,
} from "../../../scripts/lib/temporal-scheduled-probe.mjs";

const TARGET = {
  name: "poly",
  baseUrl: "https://poly-test.cognidao.org/",
  apiKey: "test-key",
};
const SCHEDULE_ID = "123e4567-e89b-12d3-a456-426614174000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createSuccessfulFetch() {
  let runPoll = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init });

    if (href.includes("/api/v1/agent/runs")) {
      runPoll += 1;
      if (runPoll === 1) {
        return jsonResponse({
          runs: [
            {
              runId: "baseline-run",
              graphId: "langgraph:poet",
              runKind: "system_scheduled",
              status: "success",
            },
          ],
        });
      }
      return jsonResponse({
        runs: [
          {
            runId: "probe-run",
            graphId: "langgraph:poet",
            runKind: "system_scheduled",
            status: runPoll === 2 ? "running" : "success",
          },
        ],
      });
    }
    if (href.endsWith("/api/v1/schedules") && init?.method === "POST") {
      return jsonResponse({ id: SCHEDULE_ID }, 201);
    }
    if (
      href.endsWith(`/api/v1/schedules/${SCHEDULE_ID}`) &&
      init?.method === "DELETE"
    ) {
      return new Response(null, { status: 204 });
    }
    if (href.endsWith("/api/v1/schedules") && !init?.method) {
      return jsonResponse({ schedules: [] });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${href}`);
  });
  return { fetchImpl, calls };
}

function deterministicOptions(
  fetchImpl: ReturnType<typeof vi.fn>,
  readLokiEvidence = vi.fn()
) {
  let elapsed = 0;
  return {
    fetchImpl,
    readLokiEvidence,
    wallClock: () => new Date("2026-10-11T12:34:30.000Z"),
    monotonicNow: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms;
    },
    makeProbeId: () => "probe-token",
    timeoutMs: 10_000,
    pollIntervalMs: 100,
  };
}

describe("cronForUtcMinute", () => {
  it("builds a five-field UTC cron", () => {
    expect(cronForUtcMinute(new Date("2026-10-11T12:36:00.000Z"))).toBe(
      "36 12 11 10 *"
    );
  });
});

describe("proveScheduledLangGraph", () => {
  it("proves the exact new terminal run, Loki correlation, and cleanup", async () => {
    const { fetchImpl, calls } = createSuccessfulFetch();
    const readLokiEvidence = vi.fn(async ({ scheduleId, graphRunId }) => ({
      entries: [
        {
          event: "worker.activity.graph_completed",
          temporalScheduleId: scheduleId,
          runId: graphRunId,
        },
      ],
      completion: {
        event: "worker.activity.graph_completed",
        scheduleId,
        graphRunId,
        // Real worker shape (scheduler.md inv. 12): scheduleId + scheduled-start suffix.
        workflowId: `${scheduleId}-2026-10-12T05:29:00Z`,
        temporalRunId: "temporal-run-id",
      },
      sourceUrl: "https://cognidao.org/observability/logs",
    }));

    const result = await proveScheduledLangGraph(
      TARGET,
      deterministicOptions(fetchImpl, readLokiEvidence)
    );

    expect(result).toMatchObject({
      target: "poly",
      baseUrl: "https://poly-test.cognidao.org",
      scheduleId: SCHEDULE_ID,
      scheduledAt: "2026-10-11T12:36:00.000Z",
      graphRunId: "probe-run",
      terminalStatus: "success",
      cleanup: { deleteStatus: 204, absent: true },
      loki: {
        entryCount: 1,
        completion: {
          workflowId: SCHEDULE_ID,
          temporalRunId: "temporal-run-id",
        },
      },
    });
    expect(readLokiEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: SCHEDULE_ID,
        graphRunId: "probe-run",
      })
    );

    const createCall = calls.find(
      (call) =>
        call.url.endsWith("/api/v1/schedules") && call.init?.method === "POST"
    );
    const body = JSON.parse(String(createCall?.init?.body));
    expect(body).toMatchObject({
      graphId: "langgraph:poet",
      cron: "36 12 11 10 *",
      timezone: "UTC",
      input: {
        modelRef: { providerKey: "platform", modelId: "gpt-oss-120b" },
      },
    });
    expect(body.input.messages[0].content).toContain("probe-token");

    const methods = calls.map((call) => call.init?.method ?? "GET");
    expect(methods).toEqual(["GET", "POST", "GET", "GET", "DELETE", "GET"]);
  });

  it("deletes and proves absence when the scheduled run fails", async () => {
    let runPoll = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/v1/agent/runs")) {
        runPoll += 1;
        return jsonResponse({
          runs:
            runPoll === 1
              ? []
              : [
                  {
                    runId: "failed-run",
                    graphId: "langgraph:poet",
                    runKind: "system_scheduled",
                    status: "error",
                    errorCode: "MODEL_ERROR",
                  },
                ],
        });
      }
      if (href.endsWith("/api/v1/schedules") && init?.method === "POST") {
        return jsonResponse({ id: SCHEDULE_ID }, 201);
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (href.endsWith("/api/v1/schedules")) {
        return jsonResponse({ schedules: [] });
      }
      throw new Error(`Unexpected request: ${href}`);
    });
    const readLokiEvidence = vi.fn();

    await expect(
      proveScheduledLangGraph(
        TARGET,
        deterministicOptions(fetchImpl, readLokiEvidence)
      )
    ).rejects.toMatchObject({ phase: "terminal_run" });

    expect(readLokiEvidence).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://poly-test.cognidao.org/api/v1/schedules/${SCHEDULE_ID}`,
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("fails closed when Loki does not correlate both IDs, then cleans up", async () => {
    const { fetchImpl } = createSuccessfulFetch();
    const readLokiEvidence = vi.fn(async () => ({
      entries: [{ runId: "probe-run" }],
    }));

    await expect(
      proveScheduledLangGraph(
        TARGET,
        deterministicOptions(fetchImpl, readLokiEvidence)
      )
    ).rejects.toMatchObject({ phase: "loki" });

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://poly-test.cognidao.org/api/v1/schedules/${SCHEDULE_ID}`,
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("recovers and deletes a committed schedule when the create response is lost", async () => {
    let scheduleListCount = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/api/v1/agent/runs")) {
        return jsonResponse({ runs: [] });
      }
      if (href.endsWith("/api/v1/schedules") && init?.method === "POST") {
        throw new TypeError("connection reset after commit");
      }
      if (href.endsWith("/api/v1/schedules") && !init?.method) {
        scheduleListCount += 1;
        return jsonResponse({
          schedules:
            scheduleListCount === 1
              ? [
                  {
                    id: SCHEDULE_ID,
                    input: {
                      messages: [
                        {
                          role: "user",
                          content:
                            "Reply with exactly TEMPORAL_PROBE_OK probe-token",
                        },
                      ],
                    },
                  },
                ]
              : [],
        });
      }
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${href}`);
    });

    await expect(
      proveScheduledLangGraph(TARGET, deterministicOptions(fetchImpl, vi.fn()))
    ).rejects.toMatchObject({ phase: "create_schedule" });

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://poly-test.cognidao.org/api/v1/schedules/${SCHEDULE_ID}`,
      expect.objectContaining({ method: "DELETE" })
    );
    expect(scheduleListCount).toBe(2);
  });

  it("retries cleanup when the first DELETE response is lost", async () => {
    const { fetchImpl } = createSuccessfulFetch();
    let deleteAttempts = 0;
    fetchImpl.mockImplementation(
      async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        if (href.includes("/api/v1/agent/runs")) {
          const polls = fetchImpl.mock.calls.filter(([calledUrl]) =>
            String(calledUrl).includes("/api/v1/agent/runs")
          ).length;
          return jsonResponse({
            runs:
              polls === 1
                ? []
                : [
                    {
                      runId: "probe-run",
                      graphId: "langgraph:poet",
                      runKind: "system_scheduled",
                      status: "success",
                    },
                  ],
          });
        }
        if (href.endsWith("/api/v1/schedules") && init?.method === "POST") {
          return jsonResponse({ id: SCHEDULE_ID }, 201);
        }
        if (init?.method === "DELETE") {
          deleteAttempts += 1;
          if (deleteAttempts === 1) throw new TypeError("response lost");
          return new Response(null, { status: 204 });
        }
        if (href.endsWith("/api/v1/schedules")) {
          return jsonResponse({ schedules: [] });
        }
        throw new Error(`Unexpected request: ${href}`);
      }
    );
    const readLokiEvidence = vi.fn(async ({ scheduleId, graphRunId }) => ({
      entries: [{ scheduleId, graphRunId }],
      completion: {
        event: "worker.activity.graph_completed",
        scheduleId,
        graphRunId,
        workflowId: scheduleId,
        temporalRunId: "temporal-run-id",
      },
    }));

    const result = await proveScheduledLangGraph(
      TARGET,
      deterministicOptions(fetchImpl, readLokiEvidence)
    );

    expect(result.cleanup).toEqual({ deleteStatus: 204, absent: true });
    expect(deleteAttempts).toBe(2);
  });
});

describe("proveScheduledLangGraphTargets", () => {
  it("runs Poly and node-template sequentially", async () => {
    const order: string[] = [];
    const targets = [
      { name: "poly", baseUrl: "https://poly.example", apiKey: "poly-key" },
      {
        name: "node-template",
        baseUrl: "https://node-template.example",
        apiKey: "template-key",
      },
    ];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const name = href.includes("poly.example") ? "poly" : "node-template";
      if (href.includes("/api/v1/agent/runs")) {
        const polls = fetchImpl.mock.calls.filter(([calledUrl]) =>
          String(calledUrl).includes(`${name}.example/api/v1/agent/runs`)
        ).length;
        if (polls === 1) return jsonResponse({ runs: [] });
        return jsonResponse({
          runs: [
            {
              runId: `${name}-run`,
              graphId: "langgraph:poet",
              runKind: "system_scheduled",
              status: "success",
            },
          ],
        });
      }
      if (href.endsWith("/api/v1/schedules") && init?.method === "POST") {
        order.push(`${name}:create`);
        return jsonResponse({
          id:
            name === "poly"
              ? "123e4567-e89b-12d3-a456-426614174000"
              : "223e4567-e89b-12d3-a456-426614174000",
        });
      }
      if (init?.method === "DELETE") {
        order.push(`${name}:delete`);
        return new Response(null, { status: 204 });
      }
      if (href.endsWith("/api/v1/schedules")) {
        return jsonResponse({ schedules: [] });
      }
      throw new Error(`Unexpected request: ${href}`);
    });
    const readLokiEvidence = vi.fn(
      async ({ target, scheduleId, graphRunId }) => ({
        entries: [{ target: target.name, scheduleId, graphRunId }],
        completion: {
          event: "worker.activity.graph_completed",
          scheduleId,
          graphRunId,
          workflowId: scheduleId,
          temporalRunId: `${target.name}-temporal-run`,
        },
      })
    );

    const results = await proveScheduledLangGraphTargets(
      targets,
      deterministicOptions(fetchImpl, readLokiEvidence)
    );

    expect(results.map((result) => result.target)).toEqual([
      "poly",
      "node-template",
    ]);
    expect(order).toEqual([
      "poly:create",
      "poly:delete",
      "node-template:create",
      "node-template:delete",
    ]);
  });
});
