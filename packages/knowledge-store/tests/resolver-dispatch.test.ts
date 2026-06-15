// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/resolver-dispatch`
 * Purpose: Unit coverage for the pure resolution-strategy router — proves a `metric:<id>` row routes to the goal loop, `agent` to the agent resolver, null/manual is skipped, and unknown namespaces are fenced off.
 * Scope: Pure classification; does not touch a cron or Temporal.
 * Invariants: METRIC_ROUTES_TO_GOAL_LOOP, DISPATCH_IS_TOTAL
 * Side-effects: none
 * Links: src/domain/resolver-dispatch.ts, docs/design/knowledge-goal-loop.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import { classifyResolutionStrategy } from "../src/domain/resolver-dispatch.js";

describe("classifyResolutionStrategy", () => {
  it("routes `metric:<id>` to the goal loop with the parsed kpiId", () => {
    expect(classifyResolutionStrategy("metric:oss-frontier-coverage")).toEqual({
      kind: "goal_loop",
      kpiId: "oss-frontier-coverage",
    });
  });

  it("routes `agent` to the agent resolver", () => {
    expect(classifyResolutionStrategy("agent")).toEqual({ kind: "agent" });
  });

  it("treats null / undefined / `manual` as manual (cron skips)", () => {
    expect(classifyResolutionStrategy(null)).toEqual({ kind: "manual" });
    expect(classifyResolutionStrategy(undefined)).toEqual({ kind: "manual" });
    expect(classifyResolutionStrategy("manual")).toEqual({ kind: "manual" });
  });

  it("fences a bare `metric:` (no kpi id) as unknown — not dispatchable", () => {
    expect(classifyResolutionStrategy("metric:")).toEqual({
      kind: "unknown",
      strategy: "metric:",
    });
  });

  it("fences an unregistered namespace as unknown", () => {
    expect(classifyResolutionStrategy("market:0x123")).toEqual({
      kind: "unknown",
      strategy: "market:0x123",
    });
  });
});
