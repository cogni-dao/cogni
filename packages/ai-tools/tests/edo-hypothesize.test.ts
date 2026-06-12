// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/edo-hypothesize`
 * Purpose: Unit coverage for the `core__edo_hypothesize` input boundary — proves the `resolution_strategy` validation admits `metric:<kpi-id>` (the goal-loop hook) while still rejecting malformed namespaced identifiers.
 * Scope: Zod boundary only; does not touch ports or I/O.
 * Invariants: goal hypotheses file with `resolution_strategy = metric:<kpi-id>`.
 * Side-effects: none
 * Links: src/tools/edo-hypothesize.ts, docs/design/knowledge-goal-loop.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import { EdoHypothesizeInputSchema } from "../src/tools/edo-hypothesize";

const base = {
  id: "goal-1",
  domain: "oss-ai",
  title: "a bounded loop can drive coverage >= 80",
  content: "the prediction",
  evaluateAt: "2026-12-31T00:00:00.000Z",
  sourceType: "agent" as const,
};

function parseStrategy(resolutionStrategy: string | undefined) {
  return EdoHypothesizeInputSchema.safeParse({ ...base, resolutionStrategy });
}

describe("core__edo_hypothesize resolution_strategy boundary", () => {
  it("admits a `metric:<kpi-id>` goal strategy", () => {
    expect(parseStrategy("metric:oss-frontier-coverage").success).toBe(true);
  });

  it("still admits `agent` and `manual`", () => {
    expect(parseStrategy("agent").success).toBe(true);
    expect(parseStrategy("manual").success).toBe(true);
  });

  it("allows omitting the strategy (manual)", () => {
    expect(parseStrategy(undefined).success).toBe(true);
  });

  it("rejects a bare `metric:` with no kpi id", () => {
    expect(parseStrategy("metric:").success).toBe(false);
  });

  it("rejects a non-namespaced identifier with spaces / parens", () => {
    expect(parseStrategy("metric:rate(0.5)").success).toBe(false);
    expect(parseStrategy("Metric:UPPER").success).toBe(false);
    expect(parseStrategy("has space").success).toBe(false);
  });
});
