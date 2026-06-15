// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/goal-loop/start.server`
 * Purpose: The goal-loop START surface — `startGoal` files a `metric:judge`
 *   hypothesis (target + budget + prose criterion encoded onto `tags`) directly
 *   to main via `edoCapability.hypothesize`, then starts `GoalLoopWorkflow`
 *   keyed on the new hypothesis id. The goal row MUST land on main (not a
 *   contrib branch) so the workflow's `loadGoalActivity` can read it back.
 * Scope: Operator-node control-plane I/O only. The pure loop control lives in
 *   `@cogni/knowledge-store/goal-loop` + the `GoalLoopWorkflow`; the per-tick
 *   activity bodies live in `service.server`. This module only SETS the goal.
 * Invariants:
 *   - GOAL_IS_HYPOTHESIS: a goal is a `hypothesis` row with
 *     `resolution_strategy='metric:judge'`; no new table, no new entry_type.
 *   - GOAL_ON_MAIN: the hypothesis is filed via `edoCapability.hypothesize`
 *     (system-sourced, direct-to-main), NOT the bearer contrib-branch path —
 *     the loop must load the row immediately.
 *   - BUDGET_VIA_TAGS: target + budget + step graph + criterion ride `tags`
 *     through `encodeGoalTags`; the codec is the only writer of those strings.
 *   - WORKFLOW_ID_IS_HYPOTHESIS_ID: `workflowClient.start(GoalLoopWorkflow,
 *     { workflowId: hypothesisId })` — one live loop per goal, idempotent start.
 * Side-effects: IO (Doltgres write via edoCapability; starts a Temporal workflow)
 * Links: docs/design/knowledge-goal-loop.md § MVP checklist (Start surface)
 * @public
 */

import type { EdoCapability } from "@cogni/ai-tools";
import {
  DEFAULT_LOOP_BUDGET,
  encodeGoalTags,
  JUDGE_KPI_ID,
  type LoopBudget,
  METRIC_STRATEGY_PREFIX,
} from "@cogni/knowledge-store";
import {
  DEFAULT_GOAL_STEP_GRAPH_ID,
  GoalLoopWorkflowInputSchema,
} from "@cogni/temporal-workflows";
import {
  type WorkflowClient,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import type { Logger } from "pino";

/** The `metric:judge` binding every MVP goal uses (one-off prose-criterion KPI). */
const JUDGE_RESOLUTION_STRATEGY =
  `${METRIC_STRATEGY_PREFIX}${JUDGE_KPI_ID}` as const;

/** How long a goal has to resolve before the wall-clock stop, if the caller omits `evaluateAt`. */
const DEFAULT_GOAL_HORIZON_MS = 24 * 60 * 60 * 1000;

export interface StartGoalInput {
  /** The goal statement (the hypothesis `content`). */
  statement: string;
  /** The prose success criterion the independent judge scores evidence against. */
  criterion: string;
  /** Registered knowledge domain the goal + its evidence atoms live in. */
  domain: string;
  /** Success threshold 0–100; the loop closes (validates) when `kpi >= target`. */
  target?: number;
  /**
   * Loop budget overrides over `DEFAULT_LOOP_BUDGET`. Each axis is independently
   * optional; an absent axis keeps the default. (`| undefined` on the members is
   * intentional — the route's Zod `.partial()` yields that shape.)
   */
  budget?: { [K in keyof LoopBudget]?: number | undefined };
  /** Graph the per-tick step runs (any registered graph id). */
  stepGraphId?: string;
  /** Hard wall-clock stop. Defaults to now + 24h. */
  evaluateAt?: Date;
}

export interface StartGoalDeps {
  edo: EdoCapability;
  workflowClient: WorkflowClient;
  taskQueue: string;
  nodeId: string;
  now: () => Date;
  log: Logger;
}

export interface StartGoalResult {
  hypothesisId: string;
  workflowId: string;
  resolutionStrategy: string;
  target: number;
  evaluateAt: string;
  alreadyRunning: boolean;
}

/** Deterministic goal id from the loop start time + statement hash-free slug — stable per call, unique enough for v0. */
function goalHypothesisId(now: Date): string {
  return `goal-${now.toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Set a goal: file the `metric:judge` hypothesis on main + start its loop.
 *
 * 1. Resolve target + budget (caller overrides over `DEFAULT_LOOP_BUDGET`).
 * 2. `edoCapability.hypothesize` — files the `hypothesis` row + commit on main
 *    with `resolution_strategy='metric:judge'` and the goal's target/budget/
 *    criterion/step-graph encoded onto `tags`.
 * 3. `workflowClient.start(GoalLoopWorkflow, { workflowId: hypothesisId })` —
 *    one live loop per goal; a duplicate start is an idempotent no-op.
 */
export async function startGoal(
  deps: StartGoalDeps,
  input: StartGoalInput
): Promise<StartGoalResult> {
  const now = deps.now();
  const target = input.target ?? 80;
  // Merge axis-by-axis so an absent (or explicitly-undefined) override keeps the
  // default — a blanket spread would overwrite a default with `undefined` under
  // exactOptionalPropertyTypes.
  const o = input.budget ?? {};
  const budget: LoopBudget = {
    maxIterations: o.maxIterations ?? DEFAULT_LOOP_BUDGET.maxIterations,
    maxTokens: o.maxTokens ?? DEFAULT_LOOP_BUDGET.maxTokens,
    maxRecursionDepth:
      o.maxRecursionDepth ?? DEFAULT_LOOP_BUDGET.maxRecursionDepth,
    maxStalledIterations:
      o.maxStalledIterations ?? DEFAULT_LOOP_BUDGET.maxStalledIterations,
  };
  const stepGraphId = input.stepGraphId ?? DEFAULT_GOAL_STEP_GRAPH_ID;
  const evaluateAt =
    input.evaluateAt ?? new Date(now.getTime() + DEFAULT_GOAL_HORIZON_MS);
  const hypothesisId = goalHypothesisId(now);

  const tags = encodeGoalTags(target, budget, {
    stepGraphId,
    successCriterion: input.criterion,
  });

  // GOAL_ON_MAIN: file via edoCapability (system-sourced, direct-to-main) so the
  // workflow can load the row immediately. tags carry the KPI params (BUDGET_VIA_TAGS).
  await deps.edo.hypothesize({
    id: hypothesisId,
    domain: input.domain,
    title: `goal: ${input.statement}`.slice(0, 200),
    content: input.statement,
    evaluateAt,
    resolutionStrategy: JUDGE_RESOLUTION_STRATEGY,
    sourceType: "derived",
    sourceRef: `goal-loop:start:${hypothesisId}`,
    sourceNode: "operator",
    tags,
  });

  // SINGLE_INPUT_CONTRACT: parse the workflow input through its source-of-truth
  // schema before starting (fail loud on a shape drift, not as an Activity 400).
  const workflowInput = GoalLoopWorkflowInputSchema.parse({
    nodeId: deps.nodeId,
    hypothesisId,
    stepGraphId,
  });

  let alreadyRunning = false;
  try {
    await deps.workflowClient.start("GoalLoopWorkflow", {
      taskQueue: deps.taskQueue,
      workflowId: hypothesisId,
      args: [workflowInput],
    });
    deps.log.info(
      { route: "goals.start", hypothesisId, stepGraphId, target },
      "goal-loop.started"
    );
  } catch (e) {
    if (e instanceof WorkflowExecutionAlreadyStartedError) {
      alreadyRunning = true;
      deps.log.info(
        { route: "goals.start", hypothesisId },
        "goal-loop.already_running"
      );
    } else {
      throw e;
    }
  }

  return {
    hypothesisId,
    workflowId: hypothesisId,
    resolutionStrategy: JUDGE_RESOLUTION_STRATEGY,
    target,
    evaluateAt: evaluateAt.toISOString(),
    alreadyRunning,
  };
}
