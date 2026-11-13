// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/_facades/metrics-facade`
 * Purpose: Prove the node's binding of the published metrics route core: every result, success or failure, becomes a response with the package status, body and `Cache-Control: no-store`; an unexpected failure is logged once and answered as a quiet 503.
 * Scope: `metrics.server.ts` over a stub container. No Next.js server, no database.
 * Invariants: NO_STORE_ON_EVERY_METRICS_RESPONSE (including errors and the list 400; main set it only on successes); TYPED_ERRORS; PORTS_FROM_CONTAINER.
 * Side-effects: none
 * Links: app/src/app/_facades/metrics.server.ts, packages/metrics/src/http.ts
 * @internal
 */

import { MetricError } from "@cogni-dao/metrics/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const container = vi.hoisted(() => ({
  log: { error: vi.fn() },
  goalMetrics: undefined as unknown,
  goalProgress: vi.fn(),
  knowledgeStorePort: undefined as unknown,
}));
vi.mock("@/bootstrap/container", () => ({ getContainer: () => container }));

import {
  metricHandlers,
  metricHttpError,
  metricResponse,
} from "@/app/_facades/metrics.server";

async function read(response: Response) {
  return {
    status: response.status,
    cache: response.headers.get("cache-control"),
    body: await response.json(),
  };
}

beforeEach(() => {
  container.log.error.mockReset();
  container.goalMetrics = undefined;
  container.knowledgeStorePort = undefined;
  container.goalProgress.mockReset();
});

describe("metrics facade", () => {
  it("sends no-store with the status and body of a success", async () => {
    container.goalProgress.mockResolvedValue({
      asOf: "2026-11-02T10:00:00.000Z",
      environment: "local",
      goals: [],
    });
    const out = await read(metricResponse(await metricHandlers().goals()));
    expect(out).toEqual({
      status: 200,
      cache: "no-store",
      body: {
        asOf: "2026-11-02T10:00:00.000Z",
        environment: "local",
        goals: [],
        historyMode: "full",
      },
    });
  });

  it("sends no-store on the list 400 and on typed 404 and 503 errors", async () => {
    const handlers = metricHandlers();
    expect(
      await read(
        metricResponse(await handlers.list(new URLSearchParams("limit=0")))
      )
    ).toEqual({
      status: 400,
      cache: "no-store",
      body: { error: "invalid_input" },
    });
    expect(
      await read(metricResponse(await handlers.subject("missing")))
    ).toEqual({
      status: 404,
      cache: "no-store",
      body: { error: "subject_not_found" },
    });
    // No metrics service on the container: a typed 503, not a throw.
    expect(await read(metricResponse(await handlers.read("any")))).toEqual({
      status: 503,
      cache: "no-store",
      body: { error: "metrics_unavailable" },
    });
    expect(container.log.error).not.toHaveBeenCalled();
  });

  it("logs an unexpected failure once and answers a quiet 503 with no-store", async () => {
    container.goalProgress.mockRejectedValue(new Error("db password leaked"));
    const out = await read(metricResponse(await metricHandlers().goals()));
    expect(out).toEqual({
      status: 503,
      cache: "no-store",
      body: { error: "metrics_unavailable" },
    });
    expect(container.log.error).toHaveBeenCalledTimes(1);
    expect(container.log.error).toHaveBeenCalledWith(
      { errorCode: "metrics_unavailable" },
      "metric.operation_failed"
    );
  });

  it("maps a route-raised error the same way", async () => {
    expect(
      await read(metricHttpError(new MetricError("metric_not_found", 404)))
    ).toEqual({
      status: 404,
      cache: "no-store",
      body: { error: "metric_not_found" },
    });
    expect(
      await read(metricHttpError(new Error("route_context_missing")))
    ).toMatchObject({ status: 503, cache: "no-store" });
    expect(container.log.error).toHaveBeenCalledTimes(1);
  });
});
