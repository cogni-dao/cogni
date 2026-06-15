// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/tests/goal-loop-input-contract.test`
 * Purpose: Contract test for `GoalLoopWorkflowInputSchema` — proves the schema is the single source of truth, `stepGraphId` defaults to `research` (goal is graph-agnostic), and misshapen inputs reject under `.strict()`.
 * Scope: Pure schema validation only; does not exercise the Temporal runtime or any I/O.
 * Invariants:
 *   - SINGLE_INPUT_CONTRACT: a canonical dispatch payload parses cleanly.
 *   - GOAL_IS_GRAPH_AGNOSTIC: omitting `stepGraphId` yields the `research` default;
 *     any registered graph id is accepted.
 *   - DISPATCH_FAIL_FAST: unknown/typo'd fields reject at parse time.
 * Side-effects: none
 * Links: src/workflows/goal-loop.schema.ts, docs/design/knowledge-goal-loop.md
 * @internal
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOAL_STEP_GRAPH_ID,
  GoalLoopWorkflowInputSchema,
} from "../src/workflows/goal-loop.schema.js";

const validFixture = {
  nodeId: "operator",
  hypothesisId: "goal:oss-frontier-coverage",
};

describe("GoalLoopWorkflowInputSchema", () => {
  it("parses a canonical payload and defaults stepGraphId to research", () => {
    const parsed = GoalLoopWorkflowInputSchema.parse(validFixture);
    expect(parsed.stepGraphId).toBe(DEFAULT_GOAL_STEP_GRAPH_ID);
  });

  it("accepts any registered graph id (goal drives any graph)", () => {
    const parsed = GoalLoopWorkflowInputSchema.parse({
      ...validFixture,
      stepGraphId: "langgraph:copy-trade-tuner",
    });
    expect(parsed.stepGraphId).toBe("langgraph:copy-trade-tuner");
  });

  it("rejects a malformed stepGraphId (must be provider:name)", () => {
    expect(
      GoalLoopWorkflowInputSchema.safeParse({
        ...validFixture,
        stepGraphId: "research",
      }).success
    ).toBe(false);
  });

  it("rejects an unknown field under .strict()", () => {
    expect(
      GoalLoopWorkflowInputSchema.safeParse({
        ...validFixture,
        graphId: "langgraph:research",
      }).success
    ).toBe(false);
  });

  it("rejects a missing required field (hypothesisId)", () => {
    const { hypothesisId: _h, ...rest } = validFixture;
    expect(GoalLoopWorkflowInputSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an empty nodeId string", () => {
    expect(
      GoalLoopWorkflowInputSchema.safeParse({ ...validFixture, nodeId: "" })
        .success
    ).toBe(false);
  });
});
