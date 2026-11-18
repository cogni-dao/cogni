// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/metrics/leases` (test)
 * Purpose: Pin the boundary of both lease metrics routes (bug.5641). Discovery: METRICS_TOKEN not configured is 500,
 *   a wrong or missing bearer is 401, a failed lane read is 503 (never an empty list), and an authorised read returns
 *   the SD groups. Relay: a malformed lane is 404 before any read, a lane that is not serving is 404, a failed lane is
 *   502 with one bounded warn carrying no token or body, and a good lane relays its text untouched.
 * Scope: Unit tests over a mocked env, capability and logging wrapper. No IO.
 * Side-effects: none
 * Links: src/app/api/metrics/leases/route.ts, src/app/api/metrics/leases/[node]/[env]/[workload]/route.ts
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "m".repeat(40);
const NODE = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const env: { METRICS_TOKEN: string | undefined } = { METRICS_TOKEN: TOKEN };
const listTargets = vi.fn();
const relay = vi.fn();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock("@/shared/env", () => ({ serverEnv: () => env }));
vi.mock("@/bootstrap/capabilities/lease-metrics", () => ({
  listLeaseScrapeTargets: (signal: AbortSignal) => listTargets(signal),
  relayLeaseMetrics: (root: string, key: unknown, signal: AbortSignal) =>
    relay(root, key, signal),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request, context: unknown) =>
      handler({ log }, request, undefined, context),
}));

const req = (path: string, authorization?: string) =>
  new Request(`https://operator.example${path}`, {
    headers: authorization ? { authorization } : {},
  }) as never;

const discover = async (authorization?: string): Promise<Response> => {
  const { GET } = await import("./route");
  return GET(req("/api/metrics/leases", authorization), {} as never);
};

const relayGet = async (
  params: { node: string; env: string; workload: string },
  authorization?: string
): Promise<Response> => {
  const { GET } = await import("./[node]/[env]/[workload]/route");
  return GET(
    req(
      `/api/metrics/leases/${params.node}/${params.env}/${params.workload}`,
      authorization
    ),
    { params: Promise.resolve(params) } as never
  );
};

const lane = { node: NODE, env: "production", workload: "app" };

beforeEach(() => {
  env.METRICS_TOKEN = TOKEN;
  listTargets.mockReset();
  relay.mockReset();
  log.info.mockReset();
  log.warn.mockReset();
  log.error.mockReset();
});

describe("GET /api/metrics/leases (discovery)", () => {
  it("is 500 when METRICS_TOKEN is not configured and never reads lanes", async () => {
    env.METRICS_TOKEN = undefined;
    expect((await discover(`Bearer ${TOKEN}`)).status).toBe(500);
    expect(listTargets).not.toHaveBeenCalled();
  });

  it("is 401 for a missing or wrong bearer and never reads lanes", async () => {
    expect((await discover()).status).toBe(401);
    expect((await discover(`Bearer ${"x".repeat(40)}`)).status).toBe(401);
    expect(listTargets).not.toHaveBeenCalled();
  });

  it("is 503, not an empty list, when the lane read fails", async () => {
    listTargets.mockRejectedValue(new Error("db down"));
    const res = await discover(`Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
    expect(log.error).toHaveBeenCalledWith(
      { reason: "lanes_unavailable" },
      "lease_metrics_scrape"
    );
  });

  it("returns the SD groups", async () => {
    const groups = [{ targets: ["a.example.org"], labels: { node: NODE } }];
    listTargets.mockResolvedValue({ groups, truncated: false });
    const res = await discover(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(groups);
  });

  it("is 503, never a short list, when the lane read hit its bound", async () => {
    const groups = [{ targets: ["a.example.org"], labels: { node: NODE } }];
    listTargets.mockResolvedValue({ groups, truncated: true });
    const res = await discover(`Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
    expect(log.error).toHaveBeenCalledWith(
      { reason: "lanes_truncated", lanes: 1 },
      "lease_metrics_scrape"
    );
  });
});

describe("GET /api/metrics/leases/{node}/{env}/{workload} (relay)", () => {
  it("is 401 for a wrong bearer and never reads the lane", async () => {
    expect((await relayGet(lane, `Bearer ${"x".repeat(40)}`)).status).toBe(401);
    expect(relay).not.toHaveBeenCalled();
  });

  it("is 404 for a malformed lane key before any read", async () => {
    const res = await relayGet(
      { node: "../../etc", env: "production", workload: "app" },
      `Bearer ${TOKEN}`
    );
    expect(res.status).toBe(404);
    expect(relay).not.toHaveBeenCalled();
  });

  it("relays a good lane's text untouched, rooted at the operator token", async () => {
    const body = 'http_requests_total{route="x",status="2xx"} 7\n';
    relay.mockResolvedValue({ ok: true, body });
    const res = await relayGet(lane, `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(body);
    expect(relay).toHaveBeenCalledWith(
      TOKEN,
      { nodeId: NODE, env: "production", workload: "app" },
      expect.anything()
    );
  });

  it("is 404 for a lane that is not serving", async () => {
    relay.mockResolvedValue({ ok: false, reason: "not_serving" });
    expect((await relayGet(lane, `Bearer ${TOKEN}`)).status).toBe(404);
  });

  it("is 502 for a failed lane, with one bounded warn and no secret", async () => {
    relay.mockResolvedValue({ ok: false, reason: "unauthorized", status: 401 });
    const res = await relayGet(lane, `Bearer ${TOKEN}`);
    expect(res.status).toBe(502);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields, event] = log.warn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(event).toBe("lease_metrics_scrape");
    expect(fields).toEqual({
      nodeId: NODE,
      env: "production",
      workload: "app",
      reason: "unauthorized",
      upstreamStatus: 401,
    });
    expect(JSON.stringify(fields)).not.toContain(TOKEN);
  });

  it("is 503 when the lane read itself fails", async () => {
    relay.mockRejectedValue(new Error("db down"));
    expect((await relayGet(lane, `Bearer ${TOKEN}`)).status).toBe(503);
  });
});
