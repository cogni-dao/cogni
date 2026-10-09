// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: contract tests for `POST /api/internal/flight-probe`.
 * Purpose: Pin node-local service auth, fixed workflow input, and response shape.
 * Scope: Route shell with billing and Temporal mocked; no database, network, or workflow execution.
 * Invariants: no scheduler-token fallback, no caller-selected graph/actor/billing, stable service subject.
 * Side-effects: none
 * Links: task.5218, flight-probe.internal.v1.contract
 */

import { InternalFlightProbeOutputSchema } from "@cogni/node-contracts";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constants = vi.hoisted(() => ({
  nodeId: "11111111-1111-4111-8111-111111111111",
  activeKey: "p".repeat(32),
  previousKey: "q".repeat(32),
  buildSha: "a".repeat(40),
  runId: "33333333-3333-4333-8333-333333333333",
}));

const fakes = vi.hoisted(() => {
  const result = vi.fn();
  const handle = { result };
  return {
    result,
    handle,
    start: vi.fn(),
    getHandle: vi.fn(),
    getBillingAccountById: vi.fn(),
  };
});

const serverEnvMock = vi.hoisted(() =>
  vi.fn((): {
    FLIGHT_PROBE_API_KEY: string | undefined;
    APP_BUILD_SHA: string | undefined;
  } => ({
    FLIGHT_PROBE_API_KEY: JSON.stringify({
      active: "p".repeat(32),
      previous: null,
    }),
    APP_BUILD_SHA: "a".repeat(40),
  }))
);

vi.mock("@/shared/env", () => ({ serverEnv: () => serverEnvMock() }));
vi.mock("@/shared/config", () => ({ getNodeId: () => constants.nodeId }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    serviceAccountService: {
      getBillingAccountById: fakes.getBillingAccountById,
    },
  }),
  getTemporalWorkflowClient: async () => ({
    client: { start: fakes.start, getHandle: fakes.getHandle },
    taskQueue: `scheduler-tasks-${constants.nodeId}`,
  }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      _options: unknown,
      handler: (
        ctx: { log: { error: ReturnType<typeof vi.fn> } },
        request: NextRequest
      ) => Promise<Response>
    ) =>
    async (request: NextRequest) =>
      handler({ log: { error: vi.fn() } }, request),
}));

import { POST } from "@/app/api/internal/flight-probe/route";

function request(token?: string, callerFlightId?: string): NextRequest {
  return new NextRequest("http://localhost/api/internal/flight-probe", {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(callerFlightId
        ? {
            "idempotency-key": callerFlightId,
            "x-flight-id": callerFlightId,
          }
        : {}),
    },
  });
}

describe("POST /api/internal/flight-probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(42 * 15 * 60 * 1000 + 1);
    serverEnvMock.mockReturnValue({
      FLIGHT_PROBE_API_KEY: JSON.stringify({
        active: constants.activeKey,
        previous: constants.previousKey,
      }),
      APP_BUILD_SHA: constants.buildSha,
    });
    fakes.getBillingAccountById.mockResolvedValue({
      id: "00000000-0000-4000-8000-00000000b000",
      defaultVirtualKeyId: "virtual-key",
    });
    fakes.result.mockResolvedValue({ ok: true, runId: constants.runId });
    fakes.getHandle.mockReturnValue(fakes.handle);
    fakes.start.mockResolvedValue(fakes.handle);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects missing and wrong node-local credentials before side effects", async () => {
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request("wrong"))).status).toBe(401);
    expect(fakes.getBillingAccountById).not.toHaveBeenCalled();
    expect(fakes.start).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical service principal at the wire contract", () => {
    expect(
      InternalFlightProbeOutputSchema.safeParse({
        ok: true,
        runId: constants.runId,
        principalId: "service:wrong-node/flight-prober",
      }).success
    ).toBe(false);
  });

  it("returns 503 rather than falling back to another service token", async () => {
    serverEnvMock.mockReturnValue({
      FLIGHT_PROBE_API_KEY: undefined,
      APP_BUILD_SHA: constants.buildSha,
    });
    const response = await POST(request(constants.activeKey));
    expect(response.status).toBe(503);
    expect(fakes.start).not.toHaveBeenCalled();
  });

  it("accepts active and previous only during a bounded rotation", async () => {
    expect((await POST(request(constants.activeKey))).status).toBe(200);
    expect((await POST(request(constants.previousKey))).status).toBe(200);

    serverEnvMock.mockReturnValue({
      FLIGHT_PROBE_API_KEY: JSON.stringify({
        active: constants.activeKey,
        previous: null,
      }),
      APP_BUILD_SHA: constants.buildSha,
    });
    expect((await POST(request(constants.previousKey))).status).toBe(401);
  });

  it("fails closed for malformed or oversized key rings", async () => {
    serverEnvMock.mockReturnValue({
      FLIGHT_PROBE_API_KEY: JSON.stringify({
        active: constants.activeKey,
        previous: constants.previousKey,
        third: "r".repeat(32),
      }),
      APP_BUILD_SHA: constants.buildSha,
    });
    expect((await POST(request(constants.activeKey))).status).toBe(503);
    expect(fakes.start).not.toHaveBeenCalled();
  });

  it("starts the fixed local workflow as the stable service principal", async () => {
    const response = await POST(request(constants.activeKey));
    expect(response.status).toBe(200);
    expect(
      InternalFlightProbeOutputSchema.parse(await response.json())
    ).toEqual({
      ok: true,
      runId: constants.runId,
      principalId: `service:${constants.nodeId}/flight-prober`,
    });

    expect(fakes.start).toHaveBeenCalledWith(
      "GraphRunWorkflow",
      expect.objectContaining({
        taskQueue: `scheduler-tasks-${constants.nodeId}`,
        workflowId: `flight-probe:${constants.nodeId}:${constants.buildSha}:42`,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        args: [
          expect.objectContaining({
            nodeId: constants.nodeId,
            graphId: "langgraph:poet",
            executionGrantId: null,
            runKind: "system_webhook",
            triggerSource: "flight_probe",
            triggerRef: `${constants.buildSha}:42`,
            requestedBy: `service:${constants.nodeId}/flight-prober`,
            input: expect.objectContaining({
              actorUserId: "00000000-0000-4000-8000-00000000a001",
              billingAccountId: "00000000-0000-4000-8000-00000000b000",
              virtualKeyId: "virtual-key",
            }),
          }),
        ],
      })
    );
  });

  it("ignores caller flight IDs and caps execution to one Temporal identity per server window", async () => {
    await POST(request(constants.activeKey, "attacker-choice-1"));
    await POST(request(constants.activeKey, "attacker-choice-2"));

    const first = fakes.start.mock.calls[0]?.[1];
    const second = fakes.start.mock.calls[1]?.[1];
    expect(first?.workflowId).toBe(
      `flight-probe:${constants.nodeId}:${constants.buildSha}:42`
    );
    expect(second?.workflowId).toBe(first?.workflowId);
  });

  it("reports a created downstream-error run as contract-valid ok:false", async () => {
    fakes.result.mockResolvedValue({ ok: false, runId: constants.runId });
    const response = await POST(request(constants.activeKey));
    expect(
      InternalFlightProbeOutputSchema.parse(await response.json())
    ).toEqual({
      ok: false,
      runId: constants.runId,
      principalId: `service:${constants.nodeId}/flight-prober`,
    });
  });
});
