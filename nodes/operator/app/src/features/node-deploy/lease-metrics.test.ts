// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
  classifyLeaseFetch,
  deriveLeaseMetricsToken,
  LEASE_APP_LABEL,
  type LeaseScrapeLane,
  leaseScrapeTargets,
  parseLeaseLaneKey,
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
  env: "candidate-a",
  workload: "canary",
  host: "b-canary-test.example.org",
};

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

  it("ignores surrounding whitespace on the root, like the sequencer's file read", () => {
    expect(deriveLeaseMetricsToken(`${ROOT}\n`, NODE_A, "production")).toBe(
      deriveLeaseMetricsToken(ROOT, NODE_A, "production")
    );
  });
});

describe("leaseScrapeTargets", () => {
  it("gives each lane its own target, relay path and release-store labels", () => {
    expect(leaseScrapeTargets([laneA, laneB])).toEqual([
      {
        targets: ["a.example.org"],
        labels: {
          __metrics_path__: `/api/metrics/leases/${NODE_A}/production/app`,
          node: NODE_A,
          env: "production",
          workload: "app",
          service: "app",
          app: LEASE_APP_LABEL,
        },
      },
      {
        targets: ["b-canary-test.example.org"],
        labels: {
          __metrics_path__: `/api/metrics/leases/${NODE_B}/candidate-a/canary`,
          node: NODE_B,
          env: "candidate-a",
          workload: "canary",
          service: "app",
          app: LEASE_APP_LABEL,
        },
      },
    ]);
  });

  it("never labels a lane as the operator's own app", () => {
    expect(LEASE_APP_LABEL).not.toBe("cogni-template");
  });

  it("is empty with no lanes", () => {
    expect(leaseScrapeTargets([])).toEqual([]);
  });
});

describe("parseLeaseLaneKey", () => {
  it("accepts a UUID, an env and a workload label", () => {
    expect(
      parseLeaseLaneKey({ node: NODE_A, env: "production", workload: "app" })
    ).toEqual({ nodeId: NODE_A, env: "production", workload: "app" });
  });

  it.each([
    { node: "not-a-uuid", env: "production", workload: "app" },
    { node: NODE_A.toUpperCase(), env: "production", workload: "app" },
    { node: NODE_A, env: "Prod", workload: "app" },
    { node: NODE_A, env: "production", workload: "-app" },
    { node: NODE_A, env: "production", workload: "a/b" },
    { node: NODE_A, env: "production", workload: "x".repeat(64) },
  ])("refuses %o", (params) => {
    expect(parseLeaseLaneKey(params)).toBeNull();
  });
});

describe("classifyLeaseFetch", () => {
  const body = 'http_requests_total{route="x",status="2xx"} 7\n';

  it("relays a complete 200 body untouched", () => {
    expect(classifyLeaseFetch({ kind: "response", status: 200, body })).toEqual(
      { ok: true, body }
    );
  });

  it("refuses a body at the byte cap as too large, never a truncated relay", () => {
    expect(
      classifyLeaseFetch(
        { kind: "response", status: 200, body: "x".repeat(10) },
        10
      )
    ).toEqual({ ok: false, reason: "too_large", status: 200 });
  });

  it("maps 401/403 to unauthorized and the app's missing token to not_configured", () => {
    expect(
      classifyLeaseFetch({ kind: "response", status: 401, body: "" })
    ).toMatchObject({ ok: false, reason: "unauthorized", status: 401 });
    expect(
      classifyLeaseFetch({ kind: "response", status: 403, body: "" })
    ).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(
      classifyLeaseFetch({
        kind: "response",
        status: 500,
        body: '{"error":"METRICS_TOKEN not configured"}',
      })
    ).toMatchObject({ ok: false, reason: "not_configured", status: 500 });
  });

  it("maps any other status to http_error", () => {
    expect(
      classifyLeaseFetch({ kind: "response", status: 502, body: "bad" })
    ).toMatchObject({ ok: false, reason: "http_error", status: 502 });
    expect(
      classifyLeaseFetch({ kind: "response", status: 302, body: "" })
    ).toMatchObject({ ok: false, reason: "http_error", status: 302 });
  });

  it("keeps timeout and invalid_target and folds other transport codes to network", () => {
    expect(
      classifyLeaseFetch({ kind: "unreachable", code: "timeout" })
    ).toEqual({ ok: false, reason: "timeout" });
    expect(
      classifyLeaseFetch({ kind: "unreachable", code: "invalid_target" })
    ).toEqual({ ok: false, reason: "invalid_target" });
    expect(
      classifyLeaseFetch({ kind: "unreachable", code: "ECONNRESET" })
    ).toEqual({ ok: false, reason: "network" });
  });
});
