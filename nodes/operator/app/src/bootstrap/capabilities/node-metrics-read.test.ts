// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-metrics-read` (test)
 * Purpose: Pin the upstream call of the node metrics read proxy (story.5169): it dials the governed datasource proxy
 *   with the operator's service-account bearer, relays status and body unchanged, refuses a body over the cap, maps a
 *   deadline to `timeout`, and retries discovery after a failure.
 * Scope: Unit tests over a stubbed discovery, `fetch` and env. No IO. Discovery itself is pinned in `grafana-mimir.test.ts`.
 * Side-effects: none
 * @public
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env: {
  GRAFANA_URL: string | undefined;
  GRAFANA_SERVICE_ACCOUNT_TOKEN: string | undefined;
} = {
  GRAFANA_URL: "https://ops.grafana.net",
  GRAFANA_SERVICE_ACCOUNT_TOKEN: "sa-token",
};
const discover = vi.fn();
vi.mock("@/shared/env", () => ({ serverEnv: () => env }));
vi.mock("@/adapters/server", () => ({
  discoverGrafanaMimirSource: (input: unknown) => discover(input),
}));

const SOURCE =
  "https://ops.grafana.net/api/datasources/proxy/uid/grafanacloud-prom";
const source = { url: SOURCE, bearerToken: "sa-token" };

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  discover.mockReset();
  discover.mockResolvedValue(source);
  env.GRAFANA_URL = "https://ops.grafana.net";
  env.GRAFANA_SERVICE_ACCOUNT_TOKEN = "sa-token";
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const load = () => import("./node-metrics-read");
const params = new Map([["query", `up{node="n",env="e"}`]]);

describe("forwardNodeMetricsRead", () => {
  it("is not_configured without Grafana and dials nothing", async () => {
    env.GRAFANA_URL = undefined;
    const { forwardNodeMetricsRead } = await load();
    expect(await forwardNodeMetricsRead("query", params)).toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(discover).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls the governed datasource proxy with the service-account bearer and relays the answer unchanged", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"status":"error","errorType":"bad_data"}', {
        status: 422,
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    );
    const { forwardNodeMetricsRead } = await load();
    const result = await forwardNodeMetricsRead("query_range", params);
    expect(result).toEqual({
      ok: true,
      status: 422,
      body: '{"status":"error","errorType":"bad_data"}',
      contentType: "application/json; charset=utf-8",
    });
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({
        grafanaUrl: "https://ops.grafana.net",
        bearerToken: "sa-token",
      })
    );
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe(`${SOURCE}/api/v1/query_range`);
    expect(url.searchParams.get("query")).toBe(`up{node="n",env="e"}`);
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer sa-token"
    );
    expect(init.redirect).toBe("error");
  });

  it("refuses a body over the cap, and discovers once across reads", async () => {
    const { forwardNodeMetricsRead, NODE_METRICS_READ_MAX_BYTES } =
      await load();
    fetchMock
      .mockResolvedValueOnce(
        new Response("x".repeat(NODE_METRICS_READ_MAX_BYTES + 1))
      )
      .mockResolvedValueOnce(new Response("{}"));
    expect(await forwardNodeMetricsRead("query", params)).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect((await forwardNodeMetricsRead("query", params)).ok).toBe(true);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("is upstream_unavailable on a network or discovery failure, and retries discovery next time", async () => {
    discover.mockRejectedValueOnce(new Error("grafana down"));
    fetchMock.mockResolvedValueOnce(new Response("{}"));
    const { forwardNodeMetricsRead } = await load();
    expect(await forwardNodeMetricsRead("query", params)).toEqual({
      ok: false,
      reason: "upstream_unavailable",
    });
    expect((await forwardNodeMetricsRead("query", params)).ok).toBe(true);
    expect(discover).toHaveBeenCalledTimes(2);

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await forwardNodeMetricsRead("query", params)).toEqual({
      ok: false,
      reason: "upstream_unavailable",
    });
  });

  it("maps a deadline to timeout", async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error("timed out"), { name: "TimeoutError" })
    );
    const { forwardNodeMetricsRead } = await load();
    expect(await forwardNodeMetricsRead("query", params)).toEqual({
      ok: false,
      reason: "timeout",
    });
  });
});
