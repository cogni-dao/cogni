// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGrafanaMimirAdapter,
  createLazyGrafanaMimirAdapter,
} from "./grafana-mimir.adapter";

const config = {
  grafanaUrl: "https://fixture.grafana.net",
  bearerToken: "fixture-not-a-real-token",
  timeoutMs: 1000,
};
const datasource = {
  uid: "grafanacloud-prom",
  type: "prometheus",
  url: "https://prometheus-fixture.grafana.net/api/prom",
};

afterEach(() => vi.unstubAllGlobals());

describe("existing Grafana Prometheus authority", () => {
  it("discovers exactly the governed source and queries its same-origin proxy with bearer auth", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            datasource,
            { uid: "fixture-postgres", type: "postgres", url: "10.0.0.1:5432" },
          ])
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "success",
            data: { resultType: "vector", result: [] },
          })
        )
      );
    vi.stubGlobal("fetch", fetch);
    const adapter = await createGrafanaMimirAdapter(config);
    await adapter.queryInstant({ query: "up" });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://fixture.grafana.net/api/datasources"
    );
    expect(String(fetch.mock.calls[1]?.[0])).toContain(
      "https://fixture.grafana.net/api/datasources/proxy/uid/grafanacloud-prom/api/v1/query"
    );
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: `Bearer ${config.bearerToken}` },
    });
  });

  it("denies missing, duplicate, and foreign source identity without falling back to direct Basic credentials", async () => {
    for (const sources of [
      [],
      [datasource, datasource],
      [{ ...datasource, uid: "grafanacloud-usage" }],
    ]) {
      const fetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(sources)));
      vi.stubGlobal("fetch", fetch);
      await expect(createGrafanaMimirAdapter(config)).rejects.toThrow(
        "missing_or_ambiguous"
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("accepts the Grafana Cloud internal NLB Mimir host returned since 2026-10-21 (bug.5514)", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            ...datasource,
            url: "https://prometheus-prod-37-prod-ap-southeast-1-local-nlb.internal.grafana.net/api/prom",
          },
        ])
      )
    );
    vi.stubGlobal("fetch", fetch);
    await expect(createGrafanaMimirAdapter(config)).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("denies a substituted non-Mimir destination even at the governed UID", async () => {
    for (const url of [
      "https://billing.grafana.net/api/prom",
      "https://billing.internal.grafana.net/api/prom",
      "https://foreign.example.org/api/prom",
      "https://prometheus-x.evil.net/api/prom",
      "https://prometheus-x.grafana.net.evil.com/api/prom",
      "https://prometheus-x.internal.grafana.net.evil.com/api/prom",
      "https://prometheus-x.evil.internal.grafana.net/api/prom",
      "https://prometheus-x.internal.grafana.net/api/other",
      "http://prometheus-fixture.grafana.net/api/prom",
      "https://user:secret@prometheus-fixture.grafana.net/api/prom",
    ]) {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify([{ ...datasource, url }]))
        );
      vi.stubGlobal("fetch", fetch);
      await expect(createGrafanaMimirAdapter(config)).rejects.toThrow(
        "source_identity_invalid"
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects credential-bearing or non-HTTPS origins before sending the token", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const grafanaUrl of [
      "http://fixture.grafana.net",
      "https://user:secret@fixture.grafana.net",
      "https://fixture.grafana.net/arbitrary/path",
    ])
      await expect(
        createGrafanaMimirAdapter({ ...config, grafanaUrl })
      ).rejects.toThrow("configuration_invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("defers discovery to first read, reuses it, and retries after a failed discovery (bug.5519)", async () => {
    const vector = () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: { resultType: "vector", result: [] },
        })
      );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([datasource])))
      .mockResolvedValueOnce(vector())
      .mockResolvedValueOnce(vector());
    vi.stubGlobal("fetch", fetch);
    const port = createLazyGrafanaMimirAdapter(config);
    expect(fetch).not.toHaveBeenCalled();
    await expect(port.queryInstant({ query: "up" })).rejects.toThrow(
      "discovery_unavailable"
    );
    await port.queryInstant({ query: "up" });
    await port.queryInstant({ query: "up" });
    expect(
      fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)
    ).toEqual([
      "/api/datasources",
      "/api/datasources",
      "/api/datasources/proxy/uid/grafanacloud-prom/api/v1/query",
      "/api/datasources/proxy/uid/grafanacloud-prom/api/v1/query",
    ]);
  });
});
