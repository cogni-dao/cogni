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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { HttpLangfuseOwnershipVerifier } from "@/adapters/server/observability/langfuse-ownership.adapter";
import { HttpLangfuseReader } from "@/adapters/server/observability/langfuse-reader.adapter";

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

// Exercise the real reader/projection and independent verifier through the public handler.
describe("native projection through the authorized public API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  function wire(
    input: unknown,
    secret = "private-fixture",
    receiptMatches = true
  ) {
    const hash = "a".repeat(64),
      alias = `cogni:production:${NODE_ID}:app:v1`;
    const provider = "gen-public-projection",
      time = "2026-10-23T03:00:00Z";
    const row = {
      id: `time-03-00-00-000000_${provider}`,
      traceId: "trace-fixture",
      startTime: time,
      endTime: time,
      projectId: "project",
      parentObservationId: null,
      environment: "production",
      type: "GENERATION",
      input,
      metadata: {
        nodeId: NODE_ID,
        user_api_key_hash: hash,
        user_api_key: hash,
        user_api_key_auth: { api_key: hash, key_alias: alias },
        user_api_key_alias: alias,
        billingAccountId: secret,
      },
    };
    const fetcher = vi.fn(
      async (url: URL) =>
        new Response(
          JSON.stringify(
            String(url).includes("/spend/logs/v2")
              ? {
                  data: [
                    {
                      request_id: provider,
                      api_key: hash,
                      startTime: time,
                      metadata: {
                        user_api_key_alias: receiptMatches ? alias : "foreign",
                      },
                    },
                  ],
                  total: 1,
                }
              : { data: [row], meta: { cursor: null } }
          )
        )
    );
    vi.stubGlobal("fetch", fetcher);
    mocks.reader.mockReturnValue(
      new HttpLangfuseReader({
        baseUrl: "https://native.invalid",
        publicKey: "fixture",
        secretKey: "fixture",
        operatorEnvironment: "production",
        ownership: new HttpLangfuseOwnershipVerifier({
          baseUrl: "https://receipts.invalid",
          apiKey: "fixture",
        }),
      })
    );
    return fetcher;
  }
  const query =
    "?fromStartTime=2026-10-23T00:00:00.000Z&toStartTime=2026-10-24T00:00:00.000Z&environment=production&fields=core,io,metadata&limit=1";
  it("returns complete normal schemas, flags structural withholding, and logs no content", async () => {
    let schema: unknown = {
      type: "string",
      description: "todo status",
      enum: ["pending", "done"],
    };
    for (let i = 0; i < 11; i++) schema = { properties: schema };
    const normal = JSON.stringify({ tools: schema });
    wire(normal);
    const response = await request(query);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [{ input: normal }],
      meta: {
        cogni: { truncated: false, partial: false, attributionUnavailable: 0 },
      },
    });
    wire('{"value":"private-fixture"}');
    const withheld = await request(query);
    expect(await withheld.json()).toMatchObject({
      data: [{ input: "[REDACTED]" }],
      meta: { cogni: { truncated: true, partial: true } },
    });
    expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain(
      "private-fixture"
    );
    expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain(
      "todo status"
    );
  });
  it("returns typed502 for unsafe fallbacks without raw bodies or private logging", async () => {
    wire({ safe: "value" }, JSON.stringify("[REDACTED]"));
    const response = await request(query);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "observability_invalid_response",
    });
    expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain(
      "[REDACTED]"
    );
  });
  it("retains auth-before-read, independent receipt denial, and read-concurrency release", async () => {
    const fetcher = wire("sensitive content");
    mocks.check.mockResolvedValueOnce({
      decision: "deny",
      code: "authz_denied",
    });
    expect((await request(query)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    wire("sensitive content", "private-fixture", false);
    const response = await request(query);
    expect(await response.json()).toMatchObject({
      data: [],
      meta: { cogni: { partial: true, attributionUnavailable: 1 } },
    });
    wire("safe after failure");
    expect((await request(query)).status).toBe(200);
  });
});
