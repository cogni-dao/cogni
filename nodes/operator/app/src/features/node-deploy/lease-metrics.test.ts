// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
  collectLeaseMetrics,
  deriveLeaseMetricsToken,
  type LeaseFetchResult,
  type LeaseScrapeLane,
  stampSample,
} from "./lease-metrics";

const ROOT = "r".repeat(40);
const NODE_A = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const NODE_B = "4b06359a-0000-4000-8000-000000000001";

const laneA: LeaseScrapeLane = {
  nodeId: NODE_A,
  env: "production",
  workload: "app",
  host: "a.example.org",
};
const laneB: LeaseScrapeLane = {
  nodeId: NODE_B,
  env: "production",
  workload: "app",
  host: "b.example.org",
};

const APP_BODY = [
  "# HELP http_requests_total Total HTTP requests",
  "# TYPE http_requests_total counter",
  'http_requests_total{app="cogni-template",env="spoofed",node_id="n",route="x",status="2xx"} 7',
  "# HELP http_request_duration_ms Request duration",
  "# TYPE http_request_duration_ms histogram",
  'http_request_duration_ms_bucket{le="5",route="x"} 1',
  'http_request_duration_ms_bucket{le="+Inf",route="x"} 2',
  'http_request_duration_ms_sum{route="x"} 12',
  'http_request_duration_ms_count{route="x"} 2',
  "process_cpu_seconds_total 3.5",
  "",
].join("\n");

const ok = (body: string): LeaseFetchResult => ({
  kind: "response",
  status: 200,
  body,
});

describe("deriveLeaseMetricsToken", () => {
  it("is stable, hex, and differs by node, env and root", () => {
    const t = deriveLeaseMetricsToken(ROOT, NODE_A, "production");
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveLeaseMetricsToken(ROOT, NODE_A, "production")).toBe(t);
    expect(deriveLeaseMetricsToken(ROOT, NODE_B, "production")).not.toBe(t);
    expect(deriveLeaseMetricsToken(ROOT, NODE_A, "preview")).not.toBe(t);
    expect(
      deriveLeaseMetricsToken("x".repeat(40), NODE_A, "production")
    ).not.toBe(t);
  });
});

describe("stampSample", () => {
  const stamp = {
    node: NODE_A,
    env: "production",
    workload: "app",
    service: "app",
  };

  it("removes tenant-written identity labels and stamps the operator's", () => {
    const line = stampSample(
      'http_requests_total{env="spoofed",node="forged",workload="w",service="s",route="x"} 7',
      stamp
    );
    expect(line).toBe(
      `http_requests_total{route="x",node="${NODE_A}",env="production",workload="app",service="app"} 7`
    );
  });

  it("stamps a label-less sample and keeps escaped quotes and braces in values", () => {
    expect(stampSample("up 1", stamp)).toBe(
      `up{node="${NODE_A}",env="production",workload="app",service="app"} 1`
    );
    expect(stampSample('m{p="a\\"}b"} 2 1700000000', stamp)).toBe(
      `m{p="a\\"}b",node="${NODE_A}",env="production",workload="app",service="app"} 2 1700000000`
    );
  });

  it("drops lines it cannot parse and tenant copies of the scrape series", () => {
    expect(stampSample("not a sample line", stamp)).toBeUndefined();
    expect(stampSample('m{broken="x} 1', stamp)).toBeUndefined();
    expect(
      stampSample('cogni_lease_scrape_up{a="b"} 1', stamp)
    ).toBeUndefined();
  });
});

describe("collectLeaseMetrics", () => {
  it("scrapes each lane with its own derived bearer and merges one exposition", async () => {
    const seen: Record<string, string> = {};
    const report = await collectLeaseMetrics(
      {
        root: ROOT,
        lanes: [laneA, laneB],
        truncated: false,
        signal: new AbortController().signal,
      },
      {
        fetchLane: async (lane, token) => {
          seen[lane.nodeId] = token;
          return ok(APP_BODY);
        },
      }
    );
    expect(seen[NODE_A]).toBe(
      deriveLeaseMetricsToken(ROOT, NODE_A, "production")
    );
    expect(seen[NODE_B]).toBe(
      deriveLeaseMetricsToken(ROOT, NODE_B, "production")
    );
    expect(seen[NODE_A]).not.toBe(seen[NODE_B]);
    expect(report).toMatchObject({ lanes: 2, scraped: 2, failed: 0 });

    const lines = report.text.split("\n");
    // One HELP and one TYPE per family, and both nodes' samples grouped under it.
    expect(
      lines.filter((l) => l === "# TYPE http_requests_total counter")
    ).toHaveLength(1);
    const first = lines.indexOf("# TYPE http_requests_total counter");
    expect(lines[first + 1]).toContain(`node="${NODE_A}"`);
    expect(lines[first + 2]).toContain(`node="${NODE_B}"`);
    expect(lines[first + 1]).toContain('env="production"');
    expect(lines[first + 1]).not.toContain("spoofed");
    // Histogram parts stay in their family.
    const hist = lines.indexOf("# TYPE http_request_duration_ms histogram");
    expect(lines[hist + 1]).toContain("http_request_duration_ms_bucket");
    expect(report.text).toContain(
      `cogni_lease_scrape_up{node="${NODE_A}",env="production",workload="app",reason="ok"} 1`
    );
  });

  it("reads a failing lane as up 0 with a bounded reason and keeps the others", async () => {
    const report = await collectLeaseMetrics(
      {
        root: ROOT,
        lanes: [laneA, laneB],
        truncated: true,
        signal: new AbortController().signal,
      },
      {
        fetchLane: async (lane) =>
          lane.nodeId === NODE_A
            ? {
                kind: "response",
                status: 500,
                body: '{"error":"METRICS_TOKEN not configured"}',
              }
            : ok(APP_BODY),
      }
    );
    expect(report).toMatchObject({
      lanes: 2,
      scraped: 1,
      failed: 1,
      truncated: true,
    });
    expect(report.reasons).toEqual({ not_configured: 1, ok: 1 });
    expect(report.text).toContain(
      `cogni_lease_scrape_up{node="${NODE_A}",env="production",workload="app",reason="not_configured"} 0`
    );
    expect(report.text).toContain("cogni_lease_scrape_lanes_truncated 1");
    expect(report.text).not.toContain(
      `http_requests_total{route="x",node="${NODE_A}"`
    );
  });

  it.each([
    [{ kind: "response", status: 401, body: "" }, "unauthorized"],
    [{ kind: "response", status: 404, body: "" }, "not_found"],
    [{ kind: "response", status: 502, body: "" }, "http_error"],
    [{ kind: "unreachable", code: "timeout" }, "timeout"],
    [{ kind: "unreachable", code: "weird" }, "network"],
  ] as const)("classifies %j as %s", async (result, reason) => {
    const report = await collectLeaseMetrics(
      {
        root: ROOT,
        lanes: [laneA],
        truncated: false,
        signal: new AbortController().signal,
      },
      { fetchLane: async () => result as LeaseFetchResult }
    );
    expect(report.reasons).toEqual({ [reason]: 1 });
  });

  it("never throws when the seam throws", async () => {
    const report = await collectLeaseMetrics(
      {
        root: ROOT,
        lanes: [laneA],
        truncated: false,
        signal: new AbortController().signal,
      },
      {
        fetchLane: async () => {
          throw new Error("aborted");
        },
      }
    );
    expect(report.reasons).toEqual({ timeout: 1 });
  });
});
