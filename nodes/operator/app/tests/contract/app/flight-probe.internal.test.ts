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
import { beforeEach, describe, expect, it, vi } from "vitest";

const constants = vi.hoisted(() => ({
  nodeId: "11111111-1111-4111-8111-111111111111",
  probeKey: "p".repeat(32),
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
  vi.fn(
    (): { FLIGHT_PROBE_API_KEY: string | undefined } => ({
      FLIGHT_PROBE_API_KEY: "p".repeat(32),
    })
  )
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

function request(token?: string): NextRequest {
  return new NextRequest("http://localhost/api/internal/flight-probe", {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "idempotency-key": "probe-attempt-1",
    },
  });
}

describe("POST /api/internal/flight-probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverEnvMock.mockReturnValue({
      FLIGHT_PROBE_API_KEY: constants.probeKey,
    });
    fakes.getBillingAccountById.mockResolvedValue({
      id: "00000000-0000-4000-8000-00000000b000",
      defaultVirtualKeyId: "virtual-key",
    });
    fakes.result.mockResolvedValue({ ok: true, runId: constants.runId });
    fakes.getHandle.mockReturnValue(fakes.handle);
    fakes.start.mockResolvedValue(fakes.handle);
  });

  it("rejects missing and wrong node-local credentials before side effects", async () => {
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request("wrong"))).status).toBe(401);
    expect(fakes.getBillingAccountById).not.toHaveBeenCalled();
    expect(fakes.start).not.toHaveBeenCalled();
  });

  it("returns 503 rather than falling back to another service token", async () => {
    serverEnvMock.mockReturnValue({ FLIGHT_PROBE_API_KEY: undefined });
    const response = await POST(request(constants.probeKey));
    expect(response.status).toBe(503);
    expect(fakes.start).not.toHaveBeenCalled();
  });

  it("starts the fixed local workflow as the stable service principal", async () => {
    const response = await POST(request(constants.probeKey));
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
        workflowId: `flight-probe:${constants.nodeId}:probe-attempt-1`,
        args: [
          expect.objectContaining({
            nodeId: constants.nodeId,
            graphId: "langgraph:poet",
            executionGrantId: null,
            runKind: "system_webhook",
            triggerSource: "flight_probe",
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

  it("reports a created downstream-error run as contract-valid ok:false", async () => {
    fakes.result.mockResolvedValue({ ok: false, runId: constants.runId });
    const response = await POST(request(constants.probeKey));
    expect(InternalFlightProbeOutputSchema.parse(await response.json())).toEqual(
      {
        ok: false,
        runId: constants.runId,
        principalId: `service:${constants.nodeId}/flight-prober`,
      }
    );
  });
});
