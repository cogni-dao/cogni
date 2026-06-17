// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests for `@features/nodes/observability-logs`.
 * Purpose: Pin the SECURITY core of the log-read proxy — the node selector is always forced, and a
 *   dev-supplied `filter` can never open a second stream selector to widen scope past their node.
 * Scope: Pure logic only.
 * Links: src/features/nodes/observability-logs.ts, task.5025
 */

import { describe, expect, it } from "vitest";
import {
  buildNodeScopedLogQL,
  isObservabilityEnv,
  MAX_FILTER_LENGTH,
  ObservabilityQueryError,
} from "@/features/nodes/observability-logs";

const NODE = "f97f68f2-8406-4a3b-b5a9-d579b779f19d";

describe("buildNodeScopedLogQL", () => {
  it("forces the node/service/env selector with no filter", () => {
    expect(buildNodeScopedLogQL({ env: "production", nodeId: NODE })).toBe(
      `{env="production", service="app", node="${NODE}"}`
    );
  });

  it("appends a pipeline filter after the forced selector", () => {
    expect(
      buildNodeScopedLogQL({
        env: "candidate-a",
        nodeId: NODE,
        filter: '| json | level="error"',
      })
    ).toBe(
      `{env="candidate-a", service="app", node="${NODE}"} | json | level="error"`
    );
  });

  it("REJECTS a filter containing braces (no second stream selector)", () => {
    expect(() =>
      buildNodeScopedLogQL({
        env: "production",
        nodeId: NODE,
        filter: '} or {node="other-node"}',
      })
    ).toThrow(ObservabilityQueryError);
  });

  it("rejects even a lone opening brace", () => {
    expect(() =>
      buildNodeScopedLogQL({ env: "production", nodeId: NODE, filter: "{" })
    ).toThrow(ObservabilityQueryError);
  });

  it("rejects an over-length filter", () => {
    expect(() =>
      buildNodeScopedLogQL({
        env: "production",
        nodeId: NODE,
        filter: "x".repeat(MAX_FILTER_LENGTH + 1),
      })
    ).toThrow(ObservabilityQueryError);
  });

  it("escapes quotes/backslashes in the nodeId (no selector breakout)", () => {
    const q = buildNodeScopedLogQL({ env: "production", nodeId: 'a"b\\c' });
    expect(q).toBe('{env="production", service="app", node="a\\"b\\\\c"}');
  });

  it("treats a blank filter as no filter", () => {
    expect(
      buildNodeScopedLogQL({ env: "preview", nodeId: NODE, filter: "   " })
    ).toBe(`{env="preview", service="app", node="${NODE}"}`);
  });
});

describe("isObservabilityEnv", () => {
  it("accepts the three flight envs, rejects others", () => {
    expect(isObservabilityEnv("production")).toBe(true);
    expect(isObservabilityEnv("candidate-a")).toBe(true);
    expect(isObservabilityEnv("preview")).toBe(true);
    expect(isObservabilityEnv("local")).toBe(false);
    expect(isObservabilityEnv(null)).toBe(false);
  });
});
