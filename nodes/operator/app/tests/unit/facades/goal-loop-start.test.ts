// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/facades/goal-loop-start`
 * Purpose: Unit test for the goal-loop START facade — proves `startGoal` files a
 *   `metric:judge` hypothesis on main with target/budget/criterion/step-graph on
 *   `tags`, then starts `GoalLoopWorkflow` keyed on the new hypothesis id, and
 *   treats an already-started workflow as an idempotent no-op.
 * Scope: Pure DI — mocks the EdoCapability + WorkflowClient; no I/O, no container.
 * Invariants: GOAL_ON_MAIN (edo.hypothesize), WORKFLOW_ID_IS_HYPOTHESIS_ID,
 *   BUDGET_VIA_TAGS (target + budget + criterion ride `tags`).
 * Side-effects: none
 * Links: src/app/_facades/goal-loop/start.server.ts
 * @internal
 */

import {
  GOAL_TAG_KEYS,
  successCriterionFromTags,
} from "@cogni/knowledge-store";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";

import {
  type StartGoalDeps,
  startGoal,
} from "@/app/_facades/goal-loop/start.server";

const FIXED_NOW = new Date("2026-06-12T12:00:00.000Z");

function makeDeps(
  startImpl: (...args: unknown[]) => Promise<unknown> = vi
    .fn()
    .mockResolvedValue(undefined)
): {
  deps: StartGoalDeps;
  hypothesize: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
} {
  const hypothesize = vi.fn().mockResolvedValue({ id: "x" });
  const start = vi.fn(startImpl as never);
  const deps: StartGoalDeps = {
    edo: { hypothesize } as never,
    workflowClient: { start } as never,
    taskQueue: "scheduler-tasks-operator",
    nodeId: "operator",
    now: () => FIXED_NOW,
    log: { info: vi.fn(), error: vi.fn() } as never,
  };
  return { deps, hypothesize, start };
}

describe("startGoal", () => {
  it("files a metric:judge hypothesis on main with goal tags + starts the workflow", async () => {
    const { deps, hypothesize, start } = makeDeps();
    const result = await startGoal(deps, {
      statement: "Prove ≥3 distinct OSS frameworks beat our stack",
      criterion: "At least 3 distinct primary sources support the claim",
      domain: "oss-ai",
      target: 80,
    });

    expect(hypothesize).toHaveBeenCalledTimes(1);
    const h = hypothesize.mock.calls[0][0];
    expect(h.resolutionStrategy).toBe("metric:judge");
    expect(h.domain).toBe("oss-ai");
    expect(h.sourceType).toBe("derived");
    expect(h.evaluateAt).toBeInstanceOf(Date);
    // BUDGET_VIA_TAGS: target + criterion + step graph ride `tags`.
    expect(h.tags).toContain(`${GOAL_TAG_KEYS.target}=80`);
    expect(successCriterionFromTags(h.tags)).toBe(
      "At least 3 distinct primary sources support the claim"
    );

    // WORKFLOW_ID_IS_HYPOTHESIS_ID
    expect(start).toHaveBeenCalledTimes(1);
    const [wf, opts] = start.mock.calls[0];
    expect(wf).toBe("GoalLoopWorkflow");
    expect(opts.workflowId).toBe(result.hypothesisId);
    expect(opts.args[0].hypothesisId).toBe(result.hypothesisId);
    expect(opts.args[0].stepGraphId).toBe("langgraph:research");
    expect(result.alreadyRunning).toBe(false);
  });

  it("treats an already-started workflow as an idempotent no-op", async () => {
    // Build an instance via the prototype so `instanceof` matches without
    // coupling the test to the (version-varying) constructor arity.
    const alreadyStarted = Object.create(
      WorkflowExecutionAlreadyStartedError.prototype
    ) as Error;
    const { deps } = makeDeps(() => {
      throw alreadyStarted;
    });
    const result = await startGoal(deps, {
      statement: "dup",
      criterion: "c",
      domain: "oss-ai",
    });
    expect(result.alreadyRunning).toBe(true);
  });

  it("honors a custom stepGraphId and target", async () => {
    const { deps, start } = makeDeps();
    await startGoal(deps, {
      statement: "tune copy-trade",
      criterion: "delta < 5%",
      domain: "oss-ai",
      target: 95,
      stepGraphId: "langgraph:copy-trade-tuner",
    });
    expect(start.mock.calls[0][1].args[0].stepGraphId).toBe(
      "langgraph:copy-trade-tuner"
    );
  });
});
