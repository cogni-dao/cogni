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
    expect(stampSample("requests_up 1", stamp)).toBe(
      `requests_up{node="${NODE_A}",env="production",workload="app",service="app"} 1`
    );
    expect(stampSample('m{p="a\\"}b"} 2 1700000000', stamp)).toBe(
      `m{p="a\\"}b",node="${NODE_A}",env="production",workload="app",service="app"} 2`
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
      `cogni_lease_scrape_up{node="${NODE_A}",env="production",workload="app"} 1`
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
      `cogni_lease_scrape_up{node="${NODE_A}",env="production",workload="app"} 0`
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

  it("keeps a hostile lane from breaking the merged exposition", async () => {
    const hostile = [
      "# HELP http_requests_total bad \\q escape\u0001 and control",
      "# TYPE http_requests_total counter junk",
      "# TYPE other bogus",
      'http_requests_total{route="x",route="y"} 1',
      'http_requests_total{__name__="z"} 1',
      'http_requests_total{p="bad\\qescape"} 1',
      'http_requests_total{route="ok"} 5',
      "",
    ].join("\n");
    const report = await collectLeaseMetrics(
      {
        root: ROOT,
        lanes: [laneA, laneB],
        truncated: false,
        signal: new AbortController().signal,
      },
      {
        fetchLane: async (lane) =>
          ok(lane.nodeId === NODE_A ? hostile : APP_BODY),
      }
    );
    const lines = report.text.split("\n").filter((l) => l !== "");
    // Every line is a valid comment or a sample with a numeric value.
    for (const l of lines) {
      if (l.startsWith("# TYPE"))
        expect(l).toMatch(
          /^# TYPE \S+ (counter|gauge|histogram|summary|untyped|unknown)$/
        );
      else if (l.startsWith("# HELP"))
        expect([...l].every((ch) => ch.charCodeAt(0) >= 0x20)).toBe(true);
      else
        expect(l).toMatch(
          /^\S+ [-+0-9.eEInfNa]+( \d+)?$|\} [-+0-9.eEInfNa]+( \d+)?$/
        );
    }
    // The valid sample of the hostile lane survives; the invalid ones are dropped; lane B is untouched.
    expect(report.text).toContain(
      `http_requests_total{route="ok",node="${NODE_A}"`
    );
    expect(report.text).not.toContain("__name__");
    expect(report.text).not.toContain('route="y"');
    expect(report.text).toContain(
      `http_requests_total{node_id="n",route="x",status="2xx",node="${NODE_B}"`
    );
  });

  it("a tenant cannot re-label a series as a platform job or forge platform metrics", async () => {
    const forged = [
      'http_requests_total{job="integrations/unix",instance="x",route="a"} 1',
      'up{job="integrations/unix"} 0',
      "node_memory_MemAvailable_bytes 0",
      'probe_success{proof_class="serve"} 0',
      "# TYPE up gauge",
      "# HELP up forged",
      "",
    ].join("\n");
    const report = await collectLeaseMetrics(
      {
        root: ROOT,
        lanes: [laneA],
        truncated: false,
        signal: new AbortController().signal,
      },
      { fetchLane: async () => ok(forged) }
    );
    expect(report.text).not.toContain("integrations/unix");
    expect(report.text).not.toMatch(/^(up|node_memory|probe_success)/m);
    expect(report.text).not.toContain("# TYPE up ");
    expect(report.text).toContain(
      `http_requests_total{route="a",node="${NODE_A}"`
    );
  });

  it("owns the app label, so a lane never joins the operator's own analytics series", async () => {
    const body = [
      "# TYPE http_requests_total counter",
      'http_requests_total{app="cogni-template",status="5xx"} 1000000000',
      "",
    ].join("\n");
    const report = await collectLeaseMetrics(
      {
        root: ROOT,
        lanes: [laneA],
        truncated: false,
        signal: new AbortController().signal,
      },
      { fetchLane: async () => ok(body) }
    );
    expect(report.text).not.toContain('app="cogni-template"');
    expect(report.text).toContain('app="cogni-node"');
  });

  it("parses metadata in linear time and lets metadata alone create nothing", async () => {
    const hostile = `# HELP a${" ".repeat(4000)}x\ry`;
    const body = `${Array.from({ length: 489 }, () => hostile).join("\n")}\n# TYPE ghost counter\n# HELP ghost never sampled\n`;
    const started = Date.now();
    const report = await collectLeaseMetrics(
      {
        root: ROOT,
        lanes: [laneA],
        truncated: false,
        signal: new AbortController().signal,
      },
      { fetchLane: async () => ok(body) }
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(report.reasons).toEqual({ empty: 1 });
    expect(report.text).not.toContain("ghost");
  });

  it("refuses a lane that would pass the whole-pass sample cap", async () => {
    const lane = (i: number) => ({
      ...laneA,
      nodeId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    });
    const big = Array.from({ length: 19_000 }, (_, i) => `m_${i} 1`).join("\n");
    const lanes = Array.from({ length: 11 }, (_, i) => lane(i));
    const report = await collectLeaseMetrics(
      {
        root: ROOT,
        lanes,
        truncated: false,
        signal: new AbortController().signal,
      },
      { fetchLane: async () => ok(big) }
    );
    expect(report.scraped).toBe(10);
    expect(report.reasons).toEqual({ ok: 10, too_large: 1 });
  });

  it("bounds the cost of an adversarial line and drops it", () => {
    const stamp = { node: NODE_A, env: "production" };
    const started = Date.now();
    expect(stampSample(`a ${"1".repeat(80_000)}x`, stamp)).toBeUndefined();
    expect(stampSample(`a ${"1".repeat(4_000)}x`, stamp)).toBeUndefined();
    const manyLabels = Array.from({ length: 40 }, (_, i) => `l${i}="v"`).join(
      ","
    );
    expect(stampSample(`m{${manyLabels}} 1`, stamp)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("rebuilds the value, dropping the timestamp, from validated tokens", () => {
    const stamp = { node: NODE_A };
    expect(stampSample("m\t 1.5e3 \t 1700000000", stamp)).toBe(
      `m{node="${NODE_A}"} 1.5e3`
    );
    expect(stampSample("m +Inf", stamp)).toBe(`m{node="${NODE_A}"} +Inf`);
    expect(stampSample("m 1 2 3", stamp)).toBeUndefined();
    expect(stampSample("m 1 12.5", stamp)).toBeUndefined();
  });

  it("forwards HELP with only valid escapes and cuts on a token boundary", async () => {
    const help = [
      "# HELP a_total two \\\\x one \\q lone \\",
      "# TYPE a_total counter",
      "a_total 1",
      `# HELP b_total ${"\\\\".repeat(150)}`,
      "# TYPE b_total counter",
      "b_total 1",
      "",
    ].join("\n");
    const report = await collectLeaseMetrics(
      {
        root: ROOT,
        lanes: [laneA],
        truncated: false,
        signal: new AbortController().signal,
      },
      { fetchLane: async () => ok(help) }
    );
    const helpLines = report.text
      .split("\n")
      .filter(
        (l) => l.startsWith("# HELP a_total") || l.startsWith("# HELP b_total")
      );
    for (const l of helpLines) {
      const text = l.replace(/^# HELP \S+ /, "");
      // every backslash starts a valid pair: \\ or \n
      expect(text.replace(/\\\\|\\n/g, "")).not.toContain("\\");
      expect(text.length).toBeLessThanOrEqual(200);
    }
  });

  it("reads a 200 with no samples as up 0 reason empty, never as healthy", async () => {
    const report = await collectLeaseMetrics(
      {
        root: ROOT,
        lanes: [laneA],
        truncated: false,
        signal: new AbortController().signal,
      },
      { fetchLane: async () => ok("<html>not metrics</html>\n") }
    );
    expect(report).toMatchObject({ scraped: 0, failed: 1 });
    expect(report.reasons).toEqual({ empty: 1 });
    expect(report.text).toContain(
      `cogni_lease_scrape_up{node="${NODE_A}",env="production",workload="app"} 0`
    );
    expect(report.text).toContain('reason="empty"} 1');
  });

  it("refuses a lane that sends more samples than the cap", async () => {
    const big = Array.from({ length: 20_001 }, (_, i) => `m_${i} 1`).join("\n");
    const report = await collectLeaseMetrics(
      {
        root: ROOT,
        lanes: [laneA],
        truncated: false,
        signal: new AbortController().signal,
      },
      { fetchLane: async () => ok(big) }
    );
    expect(report.reasons).toEqual({ too_large: 1 });
    expect(report.text).not.toContain("m_1{");
  });
});
