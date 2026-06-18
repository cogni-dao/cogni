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
  MAX_QUERY_LENGTH,
  ObservabilityQueryError,
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
