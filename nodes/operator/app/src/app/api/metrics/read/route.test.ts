// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/metrics/read` (test)
 * Purpose: Pin the boundary of the node-scoped metrics read routes (story.5169): the caller's scope comes only from
 *   the Basic credential, the PromQL forwarded upstream carries the caller's node and env on every selector, a refusal
 *   never reaches Mimir, failures are bounded and logged without a token or query text, and the upstream answer is
 *   relayed unchanged.
 * Scope: Unit tests over a mocked env, upstream capability and logging wrapper. No IO.
 * Side-effects: none
 * Links: src/app/api/metrics/read/_handle.ts
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { deriveLeaseMetricsToken } from "@/features/node-deploy/lease-metrics";
import { everySelectorScoped } from "@/features/node-deploy/lease-metrics-read";

const ROOT = "m".repeat(40);
const NODE = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const OTHER = "4b06359a-0000-4000-8000-000000000001";
const env: { METRICS_TOKEN: string | undefined } = { METRICS_TOKEN: ROOT };
const forward = vi.fn();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock("@/shared/env", () => ({ serverEnv: () => env }));
vi.mock("@/bootstrap/capabilities/node-metrics-read", () => ({
  forwardNodeMetricsRead: (kind: string, params: Map<string, string>) =>
    forward(kind, params),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request) =>
      handler({ log }, request, undefined),
}));

const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const credential = (nodeId = NODE, lane = "candidate-a") =>
  basic(nodeId, deriveLeaseMetricsToken(ROOT, nodeId, lane));

const call = async (
  kind: "query" | "query_range",
  init: {
    query?: string;
    method?: "GET" | "POST";
    authorization?: string | null;
    extra?: Record<string, string>;
    form?: Record<string, string>;
  } = {}
): Promise<Response> => {
  const mod =
    kind === "query"
      ? await import("./api/v1/query/route")
      : await import("./api/v1/query_range/route");
  const url = new URL(
    `https://operator.example/api/metrics/read/api/v1/${kind}`
  );
  if (init.query !== undefined && !init.form)
    url.searchParams.set("query", init.query);
  for (const [k, v] of Object.entries(init.extra ?? {}))
    url.searchParams.set(k, v);
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {};
  const authorization =
    init.authorization === undefined ? credential() : init.authorization;
  if (authorization) headers.authorization = authorization;
  if (init.form) headers["content-type"] = "application/x-www-form-urlencoded";
  const handler = method === "POST" ? mod.POST : mod.GET;
  return handler(
    new Request(url, {
      method,
      headers,
      ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
    }) as never
  );
};

const upstreamOk = {
  ok: true,
  status: 200,
  body: '{"status":"success","data":{"resultType":"vector","result":[]}}',
  contentType: "application/json",
};

beforeEach(() => {
  env.METRICS_TOKEN = ROOT;
  forward.mockReset();
  forward.mockResolvedValue(upstreamOk);
  log.info.mockReset();
  log.warn.mockReset();
  log.error.mockReset();
});

describe("GET /api/metrics/read/api/v1/query", () => {
  it("is 500 when METRICS_TOKEN is not configured and never forwards", async () => {
    env.METRICS_TOKEN = undefined;
    expect((await call("query", { query: "up" })).status).toBe(500);
    expect(forward).not.toHaveBeenCalled();
  });

  it("is a Prometheus-shaped 401 with a Basic challenge for a missing, wrong or other-root credential", async () => {
    for (const authorization of [
      null,
      basic(NODE, "x".repeat(64)),
      basic(NODE, deriveLeaseMetricsToken("z".repeat(40), NODE, "candidate-a")),
      `Bearer ${ROOT}`,
    ]) {
      const res = await call("query", { query: "up", authorization });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic /);
      expect(await res.json()).toEqual({
        status: "error",
        errorType: "unauthorized",
        error: "Unauthorized",
      });
    }
    expect(forward).not.toHaveBeenCalled();
  });

  it("refuses node A's token presented as node B", async () => {
    const stolen = basic(OTHER, deriveLeaseMetricsToken(ROOT, NODE, "preview"));
    expect(
      (await call("query", { query: "up", authorization: stolen })).status
    ).toBe(401);
    expect(forward).not.toHaveBeenCalled();
  });

  it("scopes the forwarded query to the caller's node and env, and relays the upstream answer unchanged", async () => {
    forward.mockResolvedValue({
      ...upstreamOk,
      status: 422,
      body: '{"status":"error"}',
    });
    const res = await call("query", {
      query: `sum(rate(http_requests_total{node="${OTHER}",env="production"}[5m]))`,
      extra: { time: "1700000000", stats: "all", lookback_delta: "9h" },
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toBe('{"status":"error"}');
    const [kind, params] = forward.mock.calls[0] as [
      string,
      Map<string, string>,
    ];
    expect(kind).toBe("query");
    expect([...params.keys()].sort()).toEqual(["query", "time"]);
    expect(
      everySelectorScoped(params.get("query") ?? "", {
        nodeId: NODE,
        env: "candidate-a",
      })
    ).toBe(true);
    expect(params.get("query")).toContain(`node="${OTHER}"`);
  });

  it("takes the env from the token: a production token scopes to production", async () => {
    await call("query", {
      query: "up",
      authorization: credential(NODE, "production"),
    });
    const params = forward.mock.calls[0]?.[1] as Map<string, string>;
    expect(params.get("query")).toBe(`up{node="${NODE}",env="production"}`);
  });

  it("is a bad_data 400 for a query the grammar refuses, never forwarded, and logs no query text", async () => {
    for (const query of ["foo{", "info(up)", "x".repeat(4097), ""]) {
      const res = await call("query", { query });
      expect(res.status).toBe(400);
      expect((await res.json()).errorType).toBe("bad_data");
    }
    expect(forward).not.toHaveBeenCalled();
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).not.toContain("info(up)");
    expect(logged).toContain(NODE);
    expect(logged).toContain("node_metrics_read");
  });

  it("is 400 when a required range parameter is missing", async () => {
    const res = await call("query_range", {
      query: "up",
      extra: { start: "1", end: "2" },
    });
    expect(res.status).toBe(400);
    expect(forward).not.toHaveBeenCalled();
  });

  it("forwards a range query with exactly start, end and step", async () => {
    await call("query_range", {
      query: "rate(foo[5m])",
      extra: { start: "1", end: "2", step: "15", evil: "1" },
    });
    const [kind, params] = forward.mock.calls[0] as [
      string,
      Map<string, string>,
    ];
    expect(kind).toBe("query_range");
    expect([...params.keys()].sort()).toEqual([
      "end",
      "query",
      "start",
      "step",
    ]);
  });

  it("maps upstream failures to bounded 502/504 with one warn, no token and no query text", async () => {
    forward.mockResolvedValue({ ok: false, reason: "too_large" });
    const big = await call("query", { query: "SECRET_METRIC_NAME" });
    expect(big.status).toBe(502);
    forward.mockResolvedValue({ ok: false, reason: "timeout" });
    expect((await call("query", { query: "up" })).status).toBe(504);
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).not.toContain("SECRET_METRIC_NAME");
    expect(logged).not.toContain(ROOT);
    expect(logged).not.toContain(
      deriveLeaseMetricsToken(ROOT, NODE, "candidate-a")
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: NODE,
        env: "candidate-a",
        reason: "too_large",
      }),
      "node_metrics_read"
    );
  });
});

describe("POST /api/metrics/read/api/v1/query", () => {
  it("accepts a form-encoded body, scopes it the same way, and lets a form value win over the URL", async () => {
    await call("query", {
      method: "POST",
      query: "ignored_in_url",
      form: { query: "up", time: "5" },
    });
    const params = forward.mock.calls[0]?.[1] as Map<string, string>;
    expect(params.get("query")).toBe(`up{node="${NODE}",env="candidate-a"}`);
    expect(params.get("time")).toBe("5");
  });

  it("refuses a comment that hides a second selector behind a carriage return, never forwarded", async () => {
    for (const query of ["foo #\r or foo", 'foo # x\r or {__name__=~".+"}']) {
      expect((await call("query", { query })).status).toBe(400);
      expect(
        (
          await call("query", {
            method: "POST",
            form: { query },
          })
        ).status
      ).toBe(400);
    }
    expect(forward).not.toHaveBeenCalled();
  });

  it("caps the body by the bytes that actually arrive, not by a header", async () => {
    const mod = await import("./api/v1/query/route");
    const res = await mod.POST(
      new Request("https://operator.example/api/metrics/read/api/v1/query", {
        method: "POST",
        headers: {
          authorization: credential(),
          "content-type": "application/x-www-form-urlencoded",
          "content-length": "10",
        },
        body: `query=up&pad=${"x".repeat(20_000)}`,
      }) as never
    );
    expect(res.status).toBe(400);
    expect(forward).not.toHaveBeenCalled();
  });

  it("is 400 for an over-long range query, never forwarded", async () => {
    const res = await call("query_range", {
      query: "up",
      extra: { start: "0", end: "99999999", step: "1" },
    });
    expect(res.status).toBe(400);
    expect(forward).not.toHaveBeenCalled();
  });

  it("refuses a non-form content type and an oversized body", async () => {
    const mod = await import("./api/v1/query/route");
    const json = await mod.POST(
      new Request("https://operator.example/api/metrics/read/api/v1/query", {
        method: "POST",
        headers: {
          authorization: credential(),
          "content-type": "application/json",
        },
        body: "{}",
      }) as never
    );
    expect(json.status).toBe(400);
    const big = await call("query", {
      method: "POST",
      form: { query: "up", pad: "x".repeat(20_000) },
    });
    expect(big.status).toBe(400);
    expect(forward).not.toHaveBeenCalled();
  });

  it("is 401 without a credential, before reading the body", async () => {
    const res = await call("query", {
      method: "POST",
      authorization: null,
      form: { query: "up" },
    });
    expect(res.status).toBe(401);
    expect(forward).not.toHaveBeenCalled();
  });
});
