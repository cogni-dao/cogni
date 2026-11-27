// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  event: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/app/_facades/nodes/observability-worker.server", () => ({
  readEpochWorkerLogs: mocks.read,
}));
vi.mock("@/app/_lib/auth/route-identity", () => ({
  resolveRouteIdentity: async () => ({ ok: true, user: { id: "user" } }),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({
  resolveServiceDb: vi.fn(),
  getContainer: () => ({
    authorization: { check: async () => ({ decision: "allow" }) },
  }),
}));
vi.mock("@/bootstrap/observability.factory", () => ({
  createLokiReader: vi.fn(),
}));
vi.mock("@/bootstrap/otel", () => ({ getCurrentTraceId: vi.fn() }));
vi.mock("@/features/nodes/node-lookup", () => ({
  resolveNodeRef: async () => ({ nodeId: "node-id" }),
}));
vi.mock("@/features/nodes/observability-logs", () => ({
  FLIGHT_ENVS: ["production"],
  isFlightEnv: (x: string) => x === "production",
  ObservabilityQueryError: class extends Error {},
  resolveLogWindow: vi.fn(),
  scopeNodeLogQL: vi.fn(),
}));
vi.mock("@/shared/observability", () => ({
  makeLogger: vi.fn(),
  createRequestContext: () => ({
    reqId: "request",
    routeId: "route",
    log: { warn: mocks.warn, error: mocks.error },
  }),
  EVENT_NAMES: {
    NODE_OBSERVABILITY_LOGS_COMPLETE:
      "feature.node_observability_logs.complete",
  },
  logEvent: mocks.event,
}));

import { GET } from "@/app/api/v1/nodes/[id]/observability/logs/route";

const invoke = () =>
  GET(
    new Request(
      "http://localhost/logs?env=production&service=epoch-worker&query=PRIVATE_QUERY"
    ),
    { params: Promise.resolve({ id: "node-id" }) }
  );
const terminal = () => [
  ...mocks.event.mock.calls,
  ...mocks.warn.mock.calls,
  ...mocks.error.mock.calls,
];
describe("epoch worker log terminal event", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    [400, "invalid_query"],
    [503, "observability_unwired"],
    [502, "loki_query_failed"],
  ])("reports stable refusal %s", async (status, error) => {
    mocks.read.mockResolvedValue({
      status,
      body: { error, private: "PRIVATE_BODY" },
    });
    const response = await invoke();
    expect(response.status).toBe(status);
    expect(terminal()).toHaveLength(1);
    expect(JSON.stringify(terminal())).toContain(error);
    expect(JSON.stringify(terminal())).not.toMatch(
      /PRIVATE_BODY|PRIVATE_QUERY/
    );
  });
  it("does not log an unrecognized error body", async () => {
    mocks.read.mockResolvedValue({
      status: 502,
      body: { error: "PRIVATE_ERROR" },
    });
    await invoke();
    expect(terminal()).toHaveLength(1);
    expect(JSON.stringify(terminal())).toContain("loki_query_failed");
    expect(JSON.stringify(terminal())).not.toContain("PRIVATE_ERROR");
  });
  it.each([0, 2])("reports bounded count %s without content", async (count) => {
    const body = {
      count,
      evidence: count ? "observed" : "unknown",
      reasonCode: count ? null : "no_events_in_window",
      lines: ["PRIVATE_LINE"],
    };
    mocks.read.mockResolvedValue({ status: 200, body });
    const response = await invoke();
    expect(await response.json()).toEqual(body);
    expect(terminal()).toHaveLength(1);
    expect(mocks.event.mock.calls[0]?.[2]).toMatchObject({
      outcome: "success",
      count,
      nodeId: "node-id",
      env: "production",
    });
    expect(JSON.stringify(terminal())).not.toMatch(
      /PRIVATE_LINE|PRIVATE_QUERY/
    );
  });
});
