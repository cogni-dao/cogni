// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/nodes.langfuse.observations.route`
 * Purpose: Public auth/scope seam; invalid/foreign requests never reach shared backend.
 * Scope: In-memory route contract checks; live node auth is proven during candidate validation.
 * Invariants: Existing developer gate, native response and sanitized failures.
 * Side-effects: none (dependencies replaced)
 * Links: task.5319
 * @internal
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  node: vi.fn(),
  check: vi.fn(),
  read: vi.fn(),
  reader: vi.fn(),
  budget: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ authorization: { check: mocks.check } }),
  resolveServiceDb: () => ({}),
}));
vi.mock("@/bootstrap/observability.factory", () => ({
  createLangfuseReader: mocks.reader,
  consumeTraceReadBudget: mocks.budget,
}));
vi.mock("@/bootstrap/otel", () => ({ getCurrentTraceId: () => undefined }));
vi.mock("@/features/nodes/node-lookup", () => ({ resolveNodeRef: mocks.node }));
vi.mock("@/shared/observability", () => ({
  makeLogger: () => ({ warn: mocks.complete, error: mocks.complete }),
  createRequestContext: () => ({
    reqId: "request-1",
    routeId: "nodes.observability-langfuse-observations",
    log: { warn: mocks.complete, error: mocks.complete },
  }),
  logEvent: mocks.complete,
  EVENT_NAMES: { NODE_OBSERVABILITY_TRACES_COMPLETE: "complete" },
}));

import { GET } from "@/app/api/v1/nodes/[id]/observability/langfuse/api/public/v2/observations/route";

const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const request = (query = "", id = "operator") =>
  GET(
    new Request(
      `https://test.cognidao.org/api/v1/nodes/${id}/observability/langfuse/api/public/v2/observations${query}`
    ),
    { params: Promise.resolve({ id }) }
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ id: "agent-1" });
  mocks.node.mockResolvedValue({ nodeId: NODE_ID, slug: "operator" });
  mocks.check.mockResolvedValue({ decision: "allow", code: "allowed" });
  mocks.reader.mockReturnValue({ listObservations: mocks.read });
  mocks.budget.mockReturnValue(true);
  mocks.read.mockResolvedValue({
    data: [],
    meta: {
      cursor: null,
      cogni: {
        contractVersion: "langfuse-observations-v2.1",
        nodeId: NODE_ID,
        logicalEnvironment: "production",
        fromStartTime: "2026-10-23T00:00:00.000Z",
        toStartTime: "2026-10-24T00:00:00.000Z",
        partial: false,
        attributionUnavailable: 0,
        privacyProjected: true,
        truncated: false,
      },
    },
  });
});
describe("node-native observation route", () => {
  it("fails closed before upstream reads without identity or developer permission", async () => {
    mocks.session.mockResolvedValueOnce(null);
    expect((await request()).status).toBe(401);
    mocks.check.mockResolvedValueOnce({
      decision: "deny",
      code: "authz_denied",
    });
    expect((await request()).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("resolves slug/UUID to the same immutable node boundary and returns native data/meta", async () => {
    for (const id of ["operator", NODE_ID]) {
      const response = await request("?environment=production&limit=1", id);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({
        data: [],
        meta: { cursor: null },
      });
    }
    expect(mocks.check).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "user:agent-1",
        action: "node.flight",
        resource: `node:${NODE_ID}`,
      })
    );
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: NODE_ID, limit: 1 })
    );
  });
  it("rejects scope override and enforces request budget before upstream", async () => {
    expect((await request("?nodeId=foreign")).status).toBe(400);
    mocks.budget.mockReturnValue(false);
    expect((await request()).status).toBe(429);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("reports missing config and sanitized dependency errors with retry-after", async () => {
    mocks.reader.mockReturnValueOnce(null);
    expect((await request()).status).toBe(503);
    const failure = Object.assign(new Error("secret-auth-token"), {
      code: "observability_rate_limited",
      status: 429,
      retryAfter: "5",
    });
    mocks.read.mockRejectedValueOnce(failure);
    const response = await request();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(JSON.stringify(await response.json())).not.toContain(
      "secret-auth-token"
    );
    expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain(
      "secret-auth-token"
    );
  });
});
