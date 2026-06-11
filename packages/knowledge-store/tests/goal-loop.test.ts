// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/goal-loop`
 * Purpose: Unit coverage for the pure goal-loop halt predicate — proves the
 *   termination ordering (goal-met > wall-clock > no-progress > budget axes) and
 *   that the loop always terminates.
 * Scope: Pure predicate only. No Temporal, no langgraph, no DB.
 * Invariants: LOOP_TERMINATES
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOOP_BUDGET,
  type Goal,
  haltEdge,
  type LoopState,
  loopHaltReason,
} from "../src/domain/goal-loop.js";

const NOW = new Date("2026-06-11T00:00:00.000Z");
const FUTURE = new Date("2026-12-31T00:00:00.000Z");

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    hypothesisId: "goal-1",
    domain: "oss-ai",
    kpiId: "oss-frontier-coverage",
    target: 80,
    evaluateAt: FUTURE,
    ...overrides,
  };
}

function state(overrides: Partial<LoopState> = {}): LoopState {
  return {
    goal: goal(),
    budget: DEFAULT_LOOP_BUDGET,
    iterations: 0,
    tokensSpent: 0,
    recursionDepth: 0,
    lastKpi: 0,
    stalledIterations: 0,
    ...overrides,
  };
}

describe("loopHaltReason — termination predicate", () => {
  it("continues (null) when fresh and under every cap", () => {
    expect(loopHaltReason(state(), NOW)).toBeNull();
  });

  it("goal_met wins even on the last token", () => {
    const s = state({
      lastKpi: 80,
      tokensSpent: DEFAULT_LOOP_BUDGET.maxTokens,
      iterations: DEFAULT_LOOP_BUDGET.maxIterations,
    });
    expect(loopHaltReason(s, NOW)).toBe("goal_met");
    expect(haltEdge("goal_met")).toBe("validates");
  });

  it("wall-clock (evaluate_at) halts before the budget axes", () => {
    const s = state({ goal: goal({ evaluateAt: NOW }), lastKpi: 10 });
    expect(loopHaltReason(s, NOW)).toBe("evaluate_at_passed");
  });

  it("no_progress fires before raw iteration/token exhaustion", () => {
    const s = state({
      stalledIterations: DEFAULT_LOOP_BUDGET.maxStalledIterations,
      iterations: DEFAULT_LOOP_BUDGET.maxIterations,
    });
    expect(loopHaltReason(s, NOW)).toBe("no_progress");
    expect(haltEdge("no_progress")).toBe("invalidates");
  });

  it("halts on each exhausted budget axis", () => {
    expect(
      loopHaltReason(
        state({ iterations: DEFAULT_LOOP_BUDGET.maxIterations }),
        NOW
      )
    ).toBe("iterations_exhausted");
    expect(
      loopHaltReason(state({ tokensSpent: DEFAULT_LOOP_BUDGET.maxTokens }), NOW)
    ).toBe("tokens_exhausted");
    expect(
      loopHaltReason(
        state({ recursionDepth: DEFAULT_LOOP_BUDGET.maxRecursionDepth + 1 }),
        NOW
      )
    ).toBe("recursion_exhausted");
  });
});
