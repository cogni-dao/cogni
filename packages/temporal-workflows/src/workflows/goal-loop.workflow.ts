// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/workflows/goal-loop`
 * Purpose: The AI goal + KPI loop as a single, internally-bounded workflow run.
 *   A goal is a `hypothesis` row whose `resolution_strategy` is
 *   `metric:<kpi-id>`. This workflow loads the goal once, then loops in workflow
 *   memory (bounded by `LoopBudget`): each pass reads the KPI via a
 *   verifier-independent reader, runs the pure halt guard FIRST, and then either
 *   files the goal's outcome (halt + break) or takes ONE step that writes ONE
 *   `evidence_for`-linked atom onto the goal's chain.
 * Scope: Deterministic orchestration only; does not perform I/O (load goal, read
 *   KPI, run the step, file the outcome are all delegated to activities).
 * Invariants:
 *   - Per TEMPORAL_DETERMINISM: no I/O in workflow code; budget lives in memory.
 *   - LOOP_TERMINATES: `goalLoopDecision` runs the pure halt guard before any
 *     step; `MVP_HARD_LOOP_CAP` is a belt-and-braces ceiling on the `while`.
 *   - KPI_VERIFIER_INDEPENDENT: the KPI is read by `readKpiActivity` (a separate
 *     reader), NEVER recomputed from the row this loop is writing to.
 *   - INTERNAL_LOOP_NOT_SCHEDULE_PER_TICK (MVP): one workflow run loops to
 *     completion; no schedule CRUD, no Dolt-persisted budget (v1).
 *   - ITERATION_HISTORY_IS_THE_CHAIN: no loop-state table — each step's atom +
 *     its `evidence_for` citation IS the persisted iteration history.
 *   - ACTIVITY_IDEMPOTENCY: the per-step evidence write is keyed on
 *     `${hypothesisId}/${iteration}`; the outcome write is keyed on
 *     `${hypothesisId}`.
 * Side-effects: none (deterministic orchestration only)
 * Links: docs/design/knowledge-goal-loop.md § Pareto MVP, docs/spec/temporal-patterns.md
 * @public
 */

import {
  applyStep,
  type Goal,
  goalLoopDecision,
  type LoopBudget,
  type LoopState,
} from "@cogni/knowledge-store/goal-loop";
import { proxyActivities } from "@temporalio/workflow";
import { STANDARD_ACTIVITY_OPTIONS } from "../activity-profiles.js";
import type { GoalLoopActivities } from "../activity-types.js";
import {
  DEFAULT_GOAL_STEP_GRAPH_ID,
  type GoalLoopWorkflowInput,
} from "./goal-loop.schema.js";

const {
  loadGoalActivity,
  readKpiActivity,
  runStepActivity,
  fileGoalOutcomeActivity,
} = proxyActivities<GoalLoopActivities>(STANDARD_ACTIVITY_OPTIONS);

/**
 * Belt-and-braces ceiling on the internal `while`. The pure `loopHaltReason`
 * guard (iterations/tokens/no-progress/wall-clock) is the real terminator; this
 * is a deterministic backstop so a misconfigured budget can never spin the
 * workflow unbounded. Comfortably above any sane `maxIterations` (default 5).
 */
const MVP_HARD_LOOP_CAP = 100;

/** Terminal artifact of a completed goal loop. */
export interface GoalLoopResult {
  hypothesisId: string;
  outcome: "halted" | "no_goal";
  /** Set when the loop halted (validates|invalidates reason). */
  haltReason?: string;
  /** Iterations (evidence atoms) the loop filed before halting. */
  iterations?: number;
  /** Last KPI reading at halt time. */
  lastKpi?: number;
}

/**
 * GoalLoopWorkflow — a self-terminating goal loop in one workflow run.
 *
 * Flow:
 * 1. Activity: load the Goal + budget once from the hypothesis row.
 * 2. Loop (bounded by LoopBudget, held in workflow memory):
 *    a. Activity: read the current KPI via a verifier-INDEPENDENT reader.
 *    b. Workflow: `goalLoopDecision(state, now)` — pure halt guard FIRST.
 *       - halt → fileGoalOutcomeActivity (validates|invalidates) → break.
 *       - step → runStepActivity writes ONE `evidence_for`-linked atom; fold
 *         the step's tokens + KPI delta into LoopState (`applyStep`); continue.
 */
export async function GoalLoopWorkflow(
  input: GoalLoopWorkflowInput
): Promise<GoalLoopResult> {
  const { nodeId, hypothesisId } = input;

  // 1. Load the goal + budget once. The internal loop carries accounting in
  //    workflow memory (Temporal history) — no Dolt-persisted budget (MVP).
  const loaded = await loadGoalActivity({ nodeId, hypothesisId });
  if (loaded === null) {
    return { hypothesisId, outcome: "no_goal" };
  }

  const goal: Goal = {
    ...loaded.goal,
    evaluateAt: new Date(loaded.goal.evaluateAt),
  };
  const budget: LoopBudget = loaded.budget;
  // Step graph precedence: explicit workflow input (the `startGoal` dispatcher
  // resolves the goal's `goal-step-graph` tag into it) > the goal's tag read by
  // the activity > the default. GOAL_IS_GRAPH_AGNOSTIC.
  const stepGraphId =
    input.stepGraphId ?? loaded.stepGraphId ?? DEFAULT_GOAL_STEP_GRAPH_ID;
  const now = new Date(loaded.nowIso);

  let state: LoopState = {
    goal,
    budget,
    iterations: 0,
    tokensSpent: 0,
    recursionDepth: 0,
    lastKpi: null,
    stalledIterations: 0,
  };

  for (let guard = 0; guard < MVP_HARD_LOOP_CAP; guard += 1) {
    // a. Read the current KPI via the independent reader (NOT recomputeConfidence).
    const kpi = await readKpiActivity({ nodeId, hypothesisId });
    state = { ...state, lastKpi: kpi };

    // b. Pure decision — halt guard FIRST (LOOP_TERMINATES).
    const decision = goalLoopDecision(state, now);
    if (decision.kind === "halt") {
      await fileGoalOutcomeActivity({
        nodeId,
        hypothesisId,
        domain: goal.domain,
        edge: decision.edge,
        reason: decision.reason,
        lastKpi: kpi,
        target: goal.target,
      });
      return {
        hypothesisId,
        outcome: "halted",
        haltReason: decision.reason,
        iterations: state.iterations,
        lastKpi: kpi,
      };
    }

    // Take ONE step: file ONE evidence_for-linked atom onto the goal's chain.
    // Idempotency (ACTIVITY_IDEMPOTENCY): the atom is keyed on the stable
    // business key `${hypothesisId}/${iteration}`, so a Temporal retry reuses
    // the same atom rather than double-writing the evidence.
    const idempotencyKey = `${hypothesisId}/${state.iterations}`;
    const step = await runStepActivity({
      nodeId,
      hypothesisId,
      domain: goal.domain,
      idempotencyKey,
      iteration: state.iterations,
      stepGraphId,
    });

    // Re-read the KPI after the step and fold the result into LoopState. The
    // atom + its `evidence_for` citation are the durable iteration history
    // (ITERATION_HISTORY_IS_THE_CHAIN); the in-memory accounting just bounds
    // the loop.
    const newKpi = await readKpiActivity({ nodeId, hypothesisId });
    state = applyStep(state, {
      tokensSpent: step.tokensSpent,
      newKpi,
    });
  }

  // MVP_HARD_LOOP_CAP reached without the pure guard halting — file an
  // invalidates outcome so the goal never silently rots, then exit.
  const lastKpi = state.lastKpi ?? 0;
  await fileGoalOutcomeActivity({
    nodeId,
    hypothesisId,
    domain: goal.domain,
    edge: "invalidates",
    reason: "iterations_exhausted",
    lastKpi,
    target: goal.target,
  });
  return {
    hypothesisId,
    outcome: "halted",
    haltReason: "iterations_exhausted",
    iterations: state.iterations,
    lastKpi,
  };
}
