// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { EVENT_NAMES, type RequestContext } from "@/shared/observability";
import { createRouteTerminalLogger } from "@/shared/observability/server";

function fixture() {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const ctx: RequestContext = {
    reqId: "req-test",
    traceId: "trace-test",
    routeId: "test.route",
    clock: { now: () => "2026-01-01T00:00:00.000Z" },
    log: { info, warn, error } as unknown as Logger,
  };
  return { ctx, info, warn, error };
}

describe("createRouteTerminalLogger", () => {
  it("emits one registered success terminal with the required envelope", () => {
    const { ctx, info } = fixture();
    const terminal = createRouteTerminalLogger(
      ctx,
      EVENT_NAMES.AGENT_IDENTITY_OPERATION_COMPLETE,
      performance.now(),
      { operation: "status" }
    );

    terminal.complete({ status: 200, outcome: "success" });
    terminal.complete({ status: 500, outcome: "error" });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      event: EVENT_NAMES.AGENT_IDENTITY_OPERATION_COMPLETE,
      reqId: "req-test",
      routeId: "test.route",
      status: 200,
      outcome: "success",
      operation: "status",
    });
    expect(info.mock.calls[0]?.[0].durationMs).toEqual(expect.any(Number));
  });

  it("uses stable error codes and exposes no identifier dimensions", () => {
    const { ctx, warn } = fixture();
    createRouteTerminalLogger(
      ctx,
      EVENT_NAMES.WORK_ITEM_PRINCIPAL_OPERATION_COMPLETE,
      performance.now(),
      { operation: "claim" }
    ).complete({
      status: 403,
      outcome: "error",
      errorCode: "forbidden",
      reasonCode: "session_forbidden",
      dimensions: { conflict: false },
    });

    const payload = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      errorCode: "forbidden",
      reasonCode: "session_forbidden",
      conflict: false,
    });
    expect(Object.keys(payload)).not.toEqual(
      expect.arrayContaining([
        "userId",
        "actorId",
        "accountId",
        "workItemId",
        "coordinationId",
      ])
    );
  });
});
