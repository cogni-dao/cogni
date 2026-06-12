// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/workflows/goal-loop`
 * Purpose: One tick of the AI goal + KPI loop. A goal is a `hypothesis` row
 *   whose `resolution_strategy` is `metric:<kpi-id>`; each tick reads the KPI
 *   via a verifier-independent reader, runs the pure halt guard FIRST, and then
 *   either files the goal's outcome (halt) or takes ONE research/cite step that
 *   writes ONE `evidence_for`-linked atom onto the goal's chain.
 * Scope: Deterministic orchestration only. All I/O (load goal, read KPI, run the
 *   research graph, file the outcome) is delegated to activities. Reuses the
 *   existing `research` graph via the unified GraphRunWorkflow — no new graph.
 * Invariants:
 *   - Per TEMPORAL_DETERMINISM: no I/O in workflow code.
 *   - LOOP_TERMINATES: `goalLoopDecision` runs the pure halt guard before any step.
 *   - KPI_VERIFIER_INDEPENDENT: the KPI is read by `readKpiActivity` (a separate
 *     reader), NEVER recomputed from the row this loop is writing to.
 *   - REUSE_GRAPH_RUN_WORKFLOW: the per-tick step delegates to GraphRunWorkflow
 *     (which runs the `research` graph), exactly like ScheduledSweepWorkflow.
 *   - ITERATION_HISTORY_IS_THE_CHAIN: no loop-state table — the step's atom +
 *     `evidence_for` citation IS the persisted iteration history.
 *   - One tick per schedule fire (short-lived, well under Temporal history limits).
 * Side-effects: none (deterministic orchestration only)
 * Links: docs/design/knowledge-goal-loop.md, docs/spec/temporal-patterns.md
 * @public
 */

import { executeChild, proxyActivities, uuid4 } from "@temporalio/workflow";
import {
  goalLoopDecision,
  type Goal,
  type LoopBudget,
  type LoopState,
} from "@cogni/knowledge-store/goal-loop";
import { STANDARD_ACTIVITY_OPTIONS } from "../activity-profiles.js";
import type { GoalLoopActivities } from "../activity-types.js";
import type { GraphRunResult } from "./graph-run.workflow.js";

const {
  loadGoalStateActivity,
  readKpiActivity,
  fileGoalOutcomeActivity,
  recordStepResultActivity,
} = proxyActivities<GoalLoopActivities>(STANDARD_ACTIVITY_OPTIONS);

/** Graph the per-tick step runs. A goal step IS a research step (reused, not new). */
export const GOAL_LOOP_STEP_GRAPH_ID = "langgraph:research" as const;

/**
 * Input for GoalLoopWorkflow. Populated at schedule-registration time from the
 * goal hypothesis row (keyed on `hypothesisId`).
 */
export interface GoalLoopWorkflowInput {
  /** Owning node (routes the graph step + outcome write). */
  nodeId: string;
  /** The `knowledge.id` of the goal hypothesis this loop drives. */
  hypothesisId: string;
  /** System billing account ID (resolved at schedule creation). */
  billingAccountId: string;
  /** System virtual key ID. */
  virtualKeyId: string;
  /** Model for the research step. */
  model: string;
}

export interface GoalLoopTickResult {
  hypothesisId: string;
  outcome: "halted" | "stepped" | "no_goal";
  /** Set when the tick halted the loop. */
  haltReason?: string;
  /** Set when the tick took a step (the atom's run id). */
  runId?: string;
}

/**
 * GoalLoopWorkflow — one tick of a self-terminating goal loop.
 *
 * Flow:
 * 1. Activity: load the Goal + budget + LoopState from the hypothesis row
 *    (iteration/token accounting is read from the EDO chain, not a side table).
 * 2. Activity: read the current KPI via a verifier-INDEPENDENT reader.
 * 3. Workflow: `goalLoopDecision(state, now)` — pure halt guard FIRST.
 *      ├─ halt → fileGoalOutcomeActivity (validates|invalidates via haltEdge)
 *      └─ step → child GraphRunWorkflow runs ONE research step that writes ONE
 *                `evidence_for`-linked atom; re-read KPI; record step accounting.
 */
export async function GoalLoopWorkflow(
  input: GoalLoopWorkflowInput
): Promise<GoalLoopTickResult> {
  const { nodeId, hypothesisId, billingAccountId, virtualKeyId, model } = input;

  // 1. Load the goal + budget + accumulated loop state from the hypothesis row.
  const loaded = await loadGoalStateActivity({ nodeId, hypothesisId });
  if (loaded === null) {
    // Not a goal (no metric: strategy / undecodable budget) — nothing to drive.
    return { hypothesisId, outcome: "no_goal" };
  }

  const goal: Goal = { ...loaded.goal, evaluateAt: new Date(loaded.goal.evaluateAt) };
  const budget: LoopBudget = loaded.budget;

  // 2. Read the current KPI via the independent reader (NOT recomputeConfidence).
  const lastKpi = await readKpiActivity({ nodeId, hypothesisId });

  const state: LoopState = {
    goal,
    budget,
    iterations: loaded.iterations,
    tokensSpent: loaded.tokensSpent,
    recursionDepth: loaded.recursionDepth,
    lastKpi,
    stalledIterations: loaded.stalledIterations,
  };

  // 3. Pure decision — halt guard FIRST (LOOP_TERMINATES).
  const decision = goalLoopDecision(state, new Date(loaded.nowIso));

  if (decision.kind === "halt") {
    await fileGoalOutcomeActivity({
      nodeId,
      hypothesisId,
      domain: goal.domain,
      edge: decision.edge,
      reason: decision.reason,
      lastKpi,
      target: goal.target,
    });
    return { hypothesisId, outcome: "halted", haltReason: decision.reason };
  }

  // Step: run ONE research step that writes ONE evidence_for-linked atom.
  const runId = uuid4();
  let graphResult: GraphRunResult;
  try {
    graphResult = await executeChild("GraphRunWorkflow", {
      workflowId: `graph-run:goal:${hypothesisId}:${state.iterations}`,
      args: [
        {
          nodeId,
          graphId: GOAL_LOOP_STEP_GRAPH_ID,
          executionGrantId: null,
          input: {
            goalHypothesisId: hypothesisId,
            kpiId: goal.kpiId,
            domain: goal.domain,
            target: goal.target,
            // The research step files its finding as an atom that
            // evidence_for's the goal hypothesis (core__knowledge_write `cite`).
            citeEvidenceForId: hypothesisId,
            model,
            actorUserId: "cogni_system",
            billingAccountId,
            virtualKeyId,
          },
          runKind: "system_scheduled" as const,
          triggerSource: `goal:${hypothesisId}`,
          triggerRef: `${hypothesisId}:${state.iterations}`,
          requestedBy: "cogni_system",
          runId,
        },
      ],
    });
  } catch {
    graphResult = { ok: false, runId };
  }

  // Re-read the KPI after the step and record the result. Authoritative
  // iteration/token/no-progress accounting is folded server-side (via the pure
  // `applyStep`) against the run ledger + chain — the next tick's
  // `loadGoalStateActivity` re-reads it. The atom + its `evidence_for` citation
  // are the durable iteration history (ITERATION_HISTORY_IS_THE_CHAIN).
  const newKpi = await readKpiActivity({ nodeId, hypothesisId });

  await recordStepResultActivity({
    nodeId,
    hypothesisId,
    runId,
    ok: graphResult.ok,
    priorKpi: lastKpi,
    newKpi,
  });

  return { hypothesisId, outcome: "stepped", runId };
}
