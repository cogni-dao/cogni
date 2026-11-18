// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/metrics/leases` (test)
 * Purpose: Pin the route's boundary (bug.5641): METRICS_TOKEN not configured is 500, a wrong or missing bearer is
 *   401, a failed lane read is 503 (never an empty 200), and an authorised pass returns the merged text plus one
 *   bounded `lease_metrics_scrape` event that carries no token, host or body.
 * Scope: Unit tests over a mocked env, collector and logging wrapper. No IO.
 * Side-effects: none
 * Links: src/app/api/metrics/leases/route.ts
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "m".repeat(40);
const env: { METRICS_TOKEN: string | undefined } = { METRICS_TOKEN: TOKEN };
const collect = vi.fn();
const createCollector = vi.fn((_root: string) => collect);
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock("@/shared/env", () => ({ serverEnv: () => env }));
vi.mock("@/bootstrap/capabilities/lease-metrics", () => ({
  createLeaseMetricsCollector: (root: string) => createCollector(root),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request, context: unknown) =>
      handler({ log }, request, undefined, context),
}));

const get = async (authorization?: string): Promise<Response> => {
  const { GET } = await import("./route");
  return GET(
    new Request("https://operator.example/api/metrics/leases", {
      headers: authorization ? { authorization } : {},
    }) as never,
    {} as never
  );
};

beforeEach(() => {
  env.METRICS_TOKEN = TOKEN;
  collect.mockReset();
  createCollector.mockClear();
  log.info.mockReset();
  log.error.mockReset();
});

describe("GET /api/metrics/leases", () => {
  it("is 500 when METRICS_TOKEN is not configured and never reads lanes", async () => {
    env.METRICS_TOKEN = undefined;
    const res = await get(`Bearer ${TOKEN}`);
    expect(res.status).toBe(500);
    expect(createCollector).not.toHaveBeenCalled();
  });

  it("is 401 for a missing or wrong bearer and never reads lanes", async () => {
    expect((await get()).status).toBe(401);
    expect((await get(`Bearer ${"x".repeat(40)}`)).status).toBe(401);
    expect(createCollector).not.toHaveBeenCalled();
  });

  it("is 503, not an empty 200, when the lane read fails", async () => {
    collect.mockRejectedValue(new Error("db down"));
    const res = await get(`Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
    expect(log.error).toHaveBeenCalledWith(
      { reason: "lanes_unavailable" },
      "lease_metrics_scrape"
    );
  });

  it("returns the merged text and logs one bounded event, rooted at the operator token", async () => {
    collect.mockResolvedValue({
      text: 'cogni_lease_scrape_up{node="n"} 1\n',
      lanes: 2,
      scraped: 1,
      failed: 1,
      truncated: false,
      reasons: { ok: 1, unauthorized: 1 },
    });
    const res = await get(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe('cogni_lease_scrape_up{node="n"} 1\n');
    expect(createCollector).toHaveBeenCalledWith(TOKEN);
    expect(log.info).toHaveBeenCalledTimes(1);
    const [fields, event] = log.info.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(event).toBe("lease_metrics_scrape");
    expect(fields).toMatchObject({
      lanes: 2,
      scraped: 1,
      failed: 1,
      truncated: false,
      reasons: { ok: 1, unauthorized: 1 },
    });
    expect(JSON.stringify(fields)).not.toContain(TOKEN);
  });
});
