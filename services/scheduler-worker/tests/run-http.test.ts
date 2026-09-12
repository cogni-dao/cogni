// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/run-http.test`
 * Purpose: Unit tests for HttpGraphRunWriter + HttpExecutionGrantValidator (task.0280).
 * Scope: Stubs global fetch and asserts URL / headers / body / retryability per nodeId.
 * @internal
 */

import { SYSTEM_ACTOR } from "@cogni/ids/system";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHttpExecutionGrantValidator,
  createHttpGraphRunWriter,
  GrantExpiredError,
  GrantScopeMismatchError,
  RunHttpClientError,
} from "../src/adapters/run-http.js";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as unknown as Parameters<typeof createHttpGraphRunWriter>[0]["logger"];

const NODE_ENDPOINTS = new Map([
  ["operator", "http://operator-node-app:3000"],
  ["poly", "http://poly-node-app:3000"],
]);

const TOKEN = "test-token-min-32-characters-long";

const deps = {
  nodeEndpoints: NODE_ENDPOINTS,
  schedulerApiToken: TOKEN,
  logger: mockLogger,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  // Use vi.stubGlobal so vi.unstubAllGlobals() reliably restores the original
  // fetch between tests (direct globalThis assignment leaks across test files
  // when vitest shares a process).
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HttpGraphRunWriter", () => {
  it("POSTs createRun to the owning node's /api/internal/graph-runs with bearer token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, runId: "11111111-1111-4111-8111-111111111111" })
    );
    const writer = createHttpGraphRunWriter(deps);

    await writer.createRun(SYSTEM_ACTOR, "poly", {
      runId: "11111111-1111-4111-8111-111111111111",
      graphId: "langgraph:poet",
      runKind: "user_immediate",
      triggerSource: "api",
      triggerRef: "api:req-1",
      requestedBy: "user-1",
      stateKey: "thread-abc",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://poly-node-app:3000/api/internal/graph-runs");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      runId: "11111111-1111-4111-8111-111111111111",
      graphId: "langgraph:poet",
      runKind: "user_immediate",
      stateKey: "thread-abc",
    });
  });

  it("routes PATCH markRunStarted to the node whose nodeId was passed", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, runId: "22222222-2222-4222-8222-222222222222" })
    );
    const writer = createHttpGraphRunWriter(deps);

    await writer.markRunStarted(
      SYSTEM_ACTOR,
      "operator",
      "22222222-2222-4222-8222-222222222222",
      "trace-x"
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "http://operator-node-app:3000/api/internal/graph-runs/22222222-2222-4222-8222-222222222222"
    );
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      status: "running",
      traceId: "trace-x",
    });
  });

  it("throws RunHttpClientError with retryable=false on unknown nodeId", async () => {
    const writer = createHttpGraphRunWriter(deps);
    await expect(
      writer.createRun(SYSTEM_ACTOR, "ghost-node", {
        runId: "33333333-3333-4333-8333-333333333333",
      })
    ).rejects.toMatchObject({
      name: "RunHttpClientError",
      status: 0,
      retryable: false,
    });
  });

  it("marks 5xx as retryable and permanent 4xx as non-retryable", async () => {
    const writer = createHttpGraphRunWriter(deps);

    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 503 }));
    await expect(
      writer.createRun(SYSTEM_ACTOR, "poly", {
        runId: "44444444-4444-4444-8444-444444444444",
      })
    ).rejects.toMatchObject({ status: 503, retryable: true });

    // 400/401/403/422 are permanent — retry would fail the same way.
    for (const status of [400, 401, 403, 422]) {
      fetchMock.mockResolvedValueOnce(new Response("nope", { status }));
      await expect(
        writer.createRun(SYSTEM_ACTOR, "poly", {
          runId: "55555555-5555-4555-8555-555555555555",
        })
      ).rejects.toMatchObject({ status, retryable: false });
    }
  });

  it("marks transient 4xx (404/408/409/429) as retryable so Temporal can wait out a rollout race", async () => {
    const writer = createHttpGraphRunWriter(deps);
    for (const status of [404, 408, 409, 429]) {
      fetchMock.mockResolvedValueOnce(new Response("transient", { status }));
      await expect(
        writer.createRun(SYSTEM_ACTOR, "poly", {
          runId: "66666666-6666-4666-8666-666666666666",
        })
      ).rejects.toMatchObject({ status, retryable: true });
    }
  });
});

describe("HttpExecutionGrantValidator", () => {
  it("POSTs to /api/internal/grants/{grantId}/validate and returns parsed grant", async () => {
    const grant = {
      id: "g-1",
      userId: "u-1",
      billingAccountId: "ba-1",
      scopes: ["graph:execute:langgraph:poet"],
      expiresAt: "2030-01-01T00:00:00.000Z",
      revokedAt: null,
      createdAt: "2020-01-01T00:00:00.000Z",
    };
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, grant }));

    const validator = createHttpExecutionGrantValidator(deps);
    const out = await validator.validateGrantForGraph(
      SYSTEM_ACTOR,
      "poly",
      "g-1",
      "langgraph:poet"
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "http://poly-node-app:3000/api/internal/grants/g-1/validate"
    );
    expect(out.id).toBe("g-1");
    expect(out.expiresAt).toEqual(new Date("2030-01-01T00:00:00.000Z"));
    expect(out.revokedAt).toBeNull();
  });

  it("maps 403 grant_expired to GrantExpiredError", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "grant_expired" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );
    const validator = createHttpExecutionGrantValidator(deps);
    await expect(
      validator.validateGrantForGraph(
        SYSTEM_ACTOR,
        "poly",
        "g-2",
        "langgraph:poet"
      )
    ).rejects.toBeInstanceOf(GrantExpiredError);
  });

  it("maps 403 grant_scope_mismatch to GrantScopeMismatchError", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, error: "grant_scope_mismatch" }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
    const validator = createHttpExecutionGrantValidator(deps);
    await expect(
      validator.validateGrantForGraph(
        SYSTEM_ACTOR,
        "poly",
        "g-3",
        "langgraph:other"
      )
    ).rejects.toBeInstanceOf(GrantScopeMismatchError);
  });

  it("throws RunHttpClientError retryable on 502", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 502 }));
    const validator = createHttpExecutionGrantValidator(deps);
    await expect(
      validator.validateGrantForGraph(
        SYSTEM_ACTOR,
        "poly",
        "g-4",
        "langgraph:poet"
      )
    ).rejects.toMatchObject({ name: "RunHttpClientError", retryable: true });
  });

  it("wraps trailing slashes and URL-encodes the grantId", async () => {
    const oddEndpoints = new Map([["poly", "http://poly-node-app:3000/"]]);
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        grant: {
          id: "g-5",
          userId: "u",
          billingAccountId: "b",
          scopes: [],
          expiresAt: null,
          revokedAt: null,
          createdAt: "2020-01-01T00:00:00.000Z",
        },
      })
    );
    const validator = createHttpExecutionGrantValidator({
      ...deps,
      nodeEndpoints: oddEndpoints,
    });
    await validator.validateGrantForGraph(
      SYSTEM_ACTOR,
      "poly",
      "g 5",
      "langgraph:poet"
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://poly-node-app:3000/api/internal/grants/g%205/validate"
    );
  });
});

// story.5016 / bug.5121: network failures (DNS ENOTFOUND on stale
// COGNI_NODE_ENDPOINTS) must name the slug + resolved URL and stay retryable.
describe("network failure diagnostics", () => {
  it("wraps a fetch rejection with nodeId + resolved URL, retryable, and logs it", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENOTFOUND" },
      })
    );
    const writer = createHttpGraphRunWriter(deps);
    await expect(
      writer.createRun(SYSTEM_ACTOR, "poly", {
        runId: "11111111-1111-4111-8111-111111111111",
      })
    ).rejects.toMatchObject({
      name: "RunHttpClientError",
      retryable: true,
      status: 0,
      message: expect.stringContaining(
        'http://poly-node-app:3000/api/internal/graph-runs (nodeId "poly") network failure [ENOTFOUND]'
      ),
    });
    expect(
      (mockLogger as unknown as { error: ReturnType<typeof vi.fn> }).error
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "poly",
        url: "http://poly-node-app:3000/api/internal/graph-runs",
        code: "ENOTFOUND",
      }),
      "node endpoint unreachable"
    );
  });

  it("names the known slugs when the nodeId is missing from the map", async () => {
    const writer = createHttpGraphRunWriter(deps);
    await expect(
      writer.createRun(SYSTEM_ACTOR, "toks4", {
        runId: "11111111-1111-4111-8111-111111111111",
      })
    ).rejects.toMatchObject({
      name: "RunHttpClientError",
      retryable: false,
      message: expect.stringContaining("(known: operator, poly)"),
    });
  });
});

// Keep the exported error classes importable in one smoke spot to catch accidental removal.
describe("error exports", () => {
  it("RunHttpClientError is a throwable with status + retryable", () => {
    const err = new RunHttpClientError("x", 500, true);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(500);
    expect(err.retryable).toBe(true);
  });
});
