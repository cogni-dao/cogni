// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/goal-loop`
 * Purpose: Unit coverage for the pure goal-loop halt predicate — proves the termination ordering (goal-met > wall-clock > no-progress > budget axes) and that the loop always terminates.
 * Scope: Pure predicate only; does not touch Temporal, langgraph, or a DB.
 * Invariants: LOOP_TERMINATES
 * Side-effects: none
 * Links: src/domain/goal-loop.ts, docs/design/knowledge-goal-loop.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  applyStep,
  DEFAULT_LOOP_BUDGET,
  type Goal,
  goalLoopDecision,
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

describe("goalLoopDecision — per-tick controller decision", () => {
  it("steps when fresh and under every cap", () => {
    expect(goalLoopDecision(state(), NOW)).toEqual({ kind: "step" });
  });

  it("halts (validates) on goal_met", () => {
    const d = goalLoopDecision(state({ lastKpi: 90 }), NOW);
    expect(d).toEqual({ kind: "halt", reason: "goal_met", edge: "validates" });
  });

  it("halts (invalidates) on a budget axis", () => {
    const d = goalLoopDecision(
      state({ tokensSpent: DEFAULT_LOOP_BUDGET.maxTokens }),
      NOW
    );
    expect(d).toEqual({
      kind: "halt",
      reason: "tokens_exhausted",
      edge: "invalidates",
    });
  });
});

describe("applyStep — folds one step's accounting into LoopState", () => {
  it("bumps iterations + tokens and resets the stall streak on KPI gain", () => {
    const s = state({
      iterations: 1,
      tokensSpent: 1000,
      lastKpi: 20,
      stalledIterations: 1,
    });
    const next = applyStep(s, { tokensSpent: 500, newKpi: 35 });
    expect(next.iterations).toBe(2);
    expect(next.tokensSpent).toBe(1500);
    expect(next.lastKpi).toBe(35);
    expect(next.stalledIterations).toBe(0);
  });

  it("increments the stall streak when the KPI does not gain", () => {
    const s = state({ lastKpi: 40, stalledIterations: 1 });
    expect(
      applyStep(s, { tokensSpent: 100, newKpi: 40 }).stalledIterations
    ).toBe(2);
    expect(
      applyStep(s, { tokensSpent: 100, newKpi: 39 }).stalledIterations
    ).toBe(2);
  });

  it("treats the first read (null prior) as progress, not a stall", () => {
    const s = state({ lastKpi: null, stalledIterations: 0 });
    expect(
      applyStep(s, { tokensSpent: 100, newKpi: 0 }).stalledIterations
    ).toBe(0);
  });
});
