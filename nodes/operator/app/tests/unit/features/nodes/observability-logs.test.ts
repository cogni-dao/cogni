// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests for `@features/nodes/observability-logs`.
 * Purpose: Pin the SECURITY core of the log-read proxy — the node/service/env selector is always
 *   re-emitted server-side, a caller's full LogQL can only NARROW within their node, and any attempt
 *   to reach another node/service/env is rejected. Parity: the caller writes the same LogQL they'd
 *   paste into loki-query.sh / the MCP.
 * Scope: Pure logic only.
 * Links: src/features/nodes/observability-logs.ts, task.5025
 */

import { describe, expect, it } from "vitest";
import {
  isFlightEnv,
  MAX_MINUTES,
  MAX_QUERY_LENGTH,
  ObservabilityQueryError,
  resolveLogWindow,
  scopeNodeLogQL,
} from "@/features/nodes/observability-logs";

const NODE = "f97f68f2-8406-4a3b-b5a9-d579b779f19d";

describe("scopeNodeLogQL", () => {
  it("returns just the node app stream for an empty query", () => {
    expect(scopeNodeLogQL({ env: "production", nodeId: NODE })).toBe(
      `{env="production", service="app", node="${NODE}"}`
    );
    expect(scopeNodeLogQL({ env: "preview", nodeId: NODE, query: "   " })).toBe(
      `{env="preview", service="app", node="${NODE}"}`
    );
  });

  it("accepts a full LogQL selector and keeps the pipeline (loki-query.sh parity)", () => {
    expect(
      scopeNodeLogQL({
        env: "candidate-a",
        nodeId: NODE,
        query: `{env="candidate-a", service="app", node="${NODE}"} | json | level="error"`,
      })
    ).toBe(
      `{env="candidate-a", service="app", node="${NODE}"} | json | level="error"`
    );
  });

  it("forces env/service/node even when the caller omits them", () => {
    expect(
      scopeNodeLogQL({ env: "production", nodeId: NODE, query: "{} | json" })
    ).toBe(`{env="production", service="app", node="${NODE}"} | json`);
  });

  it("keeps an extra narrowing label matcher (e.g. stream, pod)", () => {
    expect(
      scopeNodeLogQL({
        env: "production",
        nodeId: NODE,
        query: '{stream="stderr"} | json | reqId="abc"',
      })
    ).toBe(
      `{env="production", service="app", node="${NODE}", stream="stderr"} | json | reqId="abc"`
    );
  });

  it("accepts a bare pipeline (no leading selector) as a convenience", () => {
    expect(
      scopeNodeLogQL({
        env: "production",
        nodeId: NODE,
        query: '| json | level="error"',
      })
    ).toBe(
      `{env="production", service="app", node="${NODE}"} | json | level="error"`
    );
  });

  it("REJECTS a query that targets a different node", () => {
    expect(() =>
      scopeNodeLogQL({
        env: "production",
        nodeId: NODE,
        query: '{node="other-node-uuid"} | json',
      })
    ).toThrowError(expect.objectContaining({ code: "query_out_of_scope" }));
  });

  it("REJECTS a non-app service (only app carries the node label today)", () => {
    expect(() =>
      scopeNodeLogQL({
        env: "production",
        nodeId: NODE,
        query: '{service="scheduler-worker"} | json',
      })
    ).toThrowError(expect.objectContaining({ code: "query_out_of_scope" }));
  });

  it("REJECTS a mismatched env", () => {
    expect(() =>
      scopeNodeLogQL({
        env: "production",
        nodeId: NODE,
        query: '{env="preview"} | json',
      })
    ).toThrowError(expect.objectContaining({ code: "query_out_of_scope" }));
  });

  it("REJECTS a regex matcher on a forced label (no =~ widening)", () => {
    expect(() =>
      scopeNodeLogQL({
        env: "production",
        nodeId: NODE,
        query: '{service=~"app|scheduler-worker"}',
      })
    ).toThrowError(expect.objectContaining({ code: "query_out_of_scope" }));
  });

  it("REJECTS a malformed / unparseable selector", () => {
    expect(() =>
      scopeNodeLogQL({
        env: "production",
        nodeId: NODE,
        query: "{ not-logql }",
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_query" }));
  });

  it("REJECTS a bare pipeline that smuggles a brace", () => {
    expect(() =>
      scopeNodeLogQL({
        env: "production",
        nodeId: NODE,
        query: '} or {node="other"}',
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_query" }));
  });

  it("REJECTS an over-length query", () => {
    expect(() =>
      scopeNodeLogQL({
        env: "production",
        nodeId: NODE,
        query: `{} ${"x".repeat(MAX_QUERY_LENGTH)}`,
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_query" }));
  });

  it("escapes quotes/backslashes in the nodeId (no selector breakout)", () => {
    expect(scopeNodeLogQL({ env: "production", nodeId: 'a"b\\c' })).toBe(
      '{env="production", service="app", node="a\\"b\\\\c"}'
    );
  });

  it("throws ObservabilityQueryError instances", () => {
    expect(() =>
      scopeNodeLogQL({ env: "production", nodeId: NODE, query: "{bad}" })
    ).toThrow(ObservabilityQueryError);
  });
});

describe("isFlightEnv (canonical env envelope, reused — not a local copy)", () => {
  it("accepts the deploy envs, rejects others", () => {
    expect(isFlightEnv("production")).toBe(true);
    expect(isFlightEnv("candidate-a")).toBe(true);
    expect(isFlightEnv("preview")).toBe(true);
    expect(isFlightEnv("local")).toBe(false);
    expect(isFlightEnv(null)).toBe(false);
  });
});

describe("resolveLogWindow", () => {
  // Fixed clock so window math is deterministic (no Date.now in the pure helper).
  const NOW = 1_782_000_000_000; // 2026-06-20T...Z, an arbitrary epoch-ms
  const ns = (ms: number): string => `${ms}000000`;

  it("defaults to the last 60 minutes when no params are given", () => {
    expect(resolveLogWindow({ nowMs: NOW })).toEqual({
      startNs: ns(NOW - 60 * 60_000),
      endNs: ns(NOW),
    });
  });

  it("honors a relative `minutes` window", () => {
    expect(resolveLogWindow({ nowMs: NOW, minutes: "180" })).toEqual({
      startNs: ns(NOW - 180 * 60_000),
      endNs: ns(NOW),
    });
  });

  it("clamps `minutes` to the 24h max and falls back to default on garbage", () => {
    expect(resolveLogWindow({ nowMs: NOW, minutes: "99999" }).startNs).toBe(
      ns(NOW - MAX_MINUTES * 60_000)
    );
    expect(resolveLogWindow({ nowMs: NOW, minutes: "-5" }).startNs).toBe(
      ns(NOW - 60 * 60_000)
    );
    expect(resolveLogWindow({ nowMs: NOW, minutes: "abc" }).startNs).toBe(
      ns(NOW - 60 * 60_000)
    );
  });

  it("accepts an absolute RFC3339 start/end window (loki-query.sh parity)", () => {
    const startMs = Date.parse("2026-06-19T00:00:00.000Z");
    const endMs = Date.parse("2026-06-19T06:00:00.000Z");
    expect(
      resolveLogWindow({
        nowMs: NOW,
        start: "2026-06-19T00:00:00.000Z",
        end: "2026-06-19T06:00:00.000Z",
      })
    ).toEqual({ startNs: ns(startMs), endNs: ns(endMs) });
  });

  it("accepts epoch-millisecond instants", () => {
    const startMs = NOW - 30 * 60_000;
    expect(
      resolveLogWindow({
        nowMs: NOW,
        start: String(startMs),
        end: String(NOW),
      })
    ).toEqual({ startNs: ns(startMs), endNs: ns(NOW) });
  });

  it("defaults a missing end to now, a missing start to end-1h (absolute mode)", () => {
    const endMs = NOW - 10 * 60_000;
    expect(resolveLogWindow({ nowMs: NOW, start: String(endMs) }).endNs).toBe(
      ns(NOW)
    );
    expect(resolveLogWindow({ nowMs: NOW, end: String(endMs) }).startNs).toBe(
      ns(endMs - 60 * 60_000)
    );
  });

  it("absolute overrides relative when both are present", () => {
    const startMs = NOW - 2 * 60_000;
    expect(
      resolveLogWindow({
        nowMs: NOW,
        minutes: "180",
        start: String(startMs),
        end: String(NOW),
      })
    ).toEqual({ startNs: ns(startMs), endNs: ns(NOW) });
  });

  it("REJECTS an unparseable instant", () => {
    expect(() =>
      resolveLogWindow({ nowMs: NOW, start: "not-a-date", end: String(NOW) })
    ).toThrowError(expect.objectContaining({ code: "invalid_window" }));
  });

  it("REJECTS start >= end", () => {
    expect(() =>
      resolveLogWindow({ nowMs: NOW, start: String(NOW), end: String(NOW) })
    ).toThrowError(expect.objectContaining({ code: "invalid_window" }));
  });

  it("REJECTS a span exceeding the 24h max", () => {
    const startMs = NOW - (MAX_MINUTES * 60_000 + 1);
    expect(() =>
      resolveLogWindow({ nowMs: NOW, start: String(startMs), end: String(NOW) })
    ).toThrowError(expect.objectContaining({ code: "invalid_window" }));
  });

  it("throws ObservabilityQueryError instances", () => {
    expect(() => resolveLogWindow({ nowMs: NOW, start: "bad" })).toThrow(
      ObservabilityQueryError
    );
  });
});
