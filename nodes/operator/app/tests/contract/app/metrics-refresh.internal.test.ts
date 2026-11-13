// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/metrics-refresh.internal`
 * Purpose: Contract tests for the internal goal-metric refresh dispatch, including the idle fast path (story.0031).
 * Scope: Route behavior over stubbed container, env and refresh job. Does not run the metrics engine.
 * Invariants:
 *   - AUTH_AND_VALIDATION_FIRST: bearer, dispatch key and body are checked before the idle answer.
 *   - IDLE_TICK_IS_FREE: an idle tick returns the in-memory answer and touches no dispatch receipt or refresh job.
 *   - BUSY_TICK_LOGS_COUNTS: a worked tick logs due, truncated, pruned and idle=false.
 * Side-effects: none
 * Links: src/app/api/internal/metrics/refresh/route.ts
 * @internal
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "s".repeat(32);
const NODE = "operator";
const KEY = `${NODE}/metrics:${NODE}:refresh/2026-11-13T00:00:00.000Z`;
const GRANT = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  idleTick: vi.fn(),
  runMetricsRefresh: vi.fn(),
  requests: {
    checkIdempotency: vi.fn(),
    createPendingRequest: vi.fn(),
    finalizeRequest: vi.fn(),
  },
  info: vi.fn(),
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ SCHEDULER_API_TOKEN: TOKEN }),
}));
vi.mock("@/shared/config", () => ({ getNodeId: () => NODE }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    goalMetrics: { idleTick: mocks.idleTick },
    executionRequestPort: mocks.requests,
  }),
}));
vi.mock("@/bootstrap/jobs/metrics-refresh.job", () => ({
  metricsRefreshScheduleId: (node: string) => `metrics:${node}:refresh`,
  runMetricsRefresh: (...args: unknown[]) => mocks.runMetricsRefresh(...args),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      _options: unknown,
      handler: (ctx: unknown, request: NextRequest) => Promise<Response>
    ) =>
    async (request: NextRequest) =>
      handler(
        {
          reqId: "req-1",
          routeId: "metrics.refresh.internal",
          log: { info: mocks.info, warn: vi.fn(), error: vi.fn() },
        },
        request
      ),
}));

import { POST } from "@/app/api/internal/metrics/refresh/route";

const call = (
  over: { auth?: string; key?: string | null; body?: unknown } = {}
) => {
  const headers: Record<string, string> = {
    authorization: over.auth ?? `Bearer ${TOKEN}`,
  };
  const key = over.key === undefined ? KEY : over.key;
  if (key !== null) headers["idempotency-key"] = key;
  return POST(
    new NextRequest("http://localhost:3000/api/internal/metrics/refresh", {
      method: "POST",
      headers,
      body: JSON.stringify(over.body ?? { executionGrantId: GRANT }),
    })
  );
};

describe("POST /api/internal/metrics/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.idleTick.mockReturnValue(undefined);
  });

  it("rejects a wrong bearer, a bad dispatch key and a bad body before the idle answer", async () => {
    mocks.idleTick.mockReturnValue({ scanned: 3, truncated: false });
    expect((await call({ auth: "Bearer nope" })).status).toBe(401);
    expect(
      (await call({ key: "elsewhere/x/2026-11-13T00:00:00.000Z" })).status
    ).toBe(400);
    const badBody = await call({ body: { executionGrantId: "not-a-uuid" } });
    expect(badBody.status).toBe(400);
    expect(await badBody.json()).toEqual({ error: "grant_required" });
    expect(mocks.idleTick).not.toHaveBeenCalled();
  });

  it("answers an idle tick from memory with no receipt, grant read or refresh", async () => {
    mocks.idleTick.mockReturnValue({ scanned: 3, truncated: false });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      scanned: 3,
      truncated: false,
    });
    expect(mocks.requests.checkIdempotency).not.toHaveBeenCalled();
    expect(mocks.requests.createPendingRequest).not.toHaveBeenCalled();
    expect(mocks.runMetricsRefresh).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "metric.refresh_complete",
        scanned: 3,
        dueCount: 0,
        definitionsTruncated: false,
        prunedCount: 0,
        pruneFailed: false,
        measuredCount: 0,
        errorCount: 0,
        idle: true,
        outcome: "success",
        errorCode: null,
      }),
      "metric.refresh_complete"
    );
  });

  it("runs the refresh and logs due, truncated and pruned counts when work is due", async () => {
    mocks.requests.checkIdempotency.mockResolvedValue({ status: "new" });
    mocks.requests.createPendingRequest.mockResolvedValue(undefined);
    mocks.runMetricsRefresh.mockResolvedValue({
      scanned: 5,
      due: 2,
      truncated: true,
      pruned: 4,
      pruneFailed: false,
      observations: [{ status: "ok" }, { status: "error" }],
    });
    const res = await call();
    expect(res.status).toBe(200);
    expect(mocks.runMetricsRefresh).toHaveBeenCalledWith(GRANT);
    expect(mocks.requests.finalizeRequest).toHaveBeenCalledWith(KEY, {
      ok: true,
      errorCode: null,
    });
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        scanned: 5,
        dueCount: 2,
        definitionsTruncated: true,
        prunedCount: 4,
        pruneFailed: false,
        idle: false,
        measuredCount: 2,
        errorCount: 1,
        outcome: "error",
      }),
      "metric.refresh_complete"
    );
  });
});
