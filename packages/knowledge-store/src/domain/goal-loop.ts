// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/goal-loop`
 * Purpose: Thin contract seam for the AI goal + KPI loop. A "goal" is a
 *   `hypothesis` knowledge row whose `resolution_strategy` is `metric:<kpi-id>`;
 *   the loop drives toward `metric >= target` until proven or budget-exhausted.
 * Scope: Pure types + the `metric:` resolution-strategy convention. Does NOT
 *   implement the Temporal workflow, the langgraph step, or the KPI reader —
 *   those land in a follow-up `/implement` (see docs/design/knowledge-goal-loop.md).
 * Invariants:
 *   - GOAL_IS_HYPOTHESIS — a goal reuses `entry_type='hypothesis'`; no new entry_type, no new table.
 *   - KPI_VIA_RESOLUTION_STRATEGY — the KPI binding rides the existing
 *     `resolution_strategy` column as `metric:<kpi-id>`; no schema migration.
 *   - LOOP_TERMINATES — every loop run is bounded by LoopBudget; the guard is the
 *     first thing the controller checks each iteration.
 *   - KPI_VERIFIER_INDEPENDENT — the KPI reader that produces `lastKpi` MUST be
 *     independent of the loop's own writes. The worker (storage-expert role) files
 *     evidence; a separate verifier (librarian/judge role, an external metric, or a
 *     held-out check) reads the KPI. A loop that grades itself by its own
 *     `confidence_pct` is a smoke-test only — never a real goal's KPI.
 * Side-effects: none
 * Links: docs/spec/knowledge-syntropy.md, docs/design/knowledge-goal-loop.md
 * @public
 */

import { z } from "zod";

import { ResolutionStrategySchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// `metric:` resolution-strategy convention
//
// The KPI binding is NOT a new column — it is a value of the existing
// `knowledge.resolution_strategy` text column, namespaced `metric:`. The
// already-shipped `ResolutionStrategySchema` regex
//   /^[a-z][a-z0-9_]*(:[A-Za-z0-9_./~^-]+)?$/
// already admits `metric:<kpi-id>` (e.g. `metric:oss-frontier-coverage`).
//
// The value after `metric:` is a KPI *identifier*, not an inline query — the
// regex forbids parens/spaces, and binding to an id (not an expression) keeps
// the KPI definition versioned + reusable rather than smeared across rows.
// The KPI reader (deferred) maps the id → a 0–100 number.
// ---------------------------------------------------------------------------

export const METRIC_STRATEGY_PREFIX = "metric:" as const;

/** A `resolution_strategy` value of the form `metric:<kpi-id>`. */
export const MetricResolutionStrategySchema = ResolutionStrategySchema.refine(
  (s) => s.startsWith(METRIC_STRATEGY_PREFIX),
  { message: "goal resolution_strategy must be `metric:<kpi-id>`" }
);
export type MetricResolutionStrategy = z.infer<
  typeof MetricResolutionStrategySchema
>;

/** Extract the KPI id from a `metric:<kpi-id>` strategy, or null if not a metric strategy. */
export function kpiIdFromStrategy(strategy: string | null): string | null {
  if (strategy === null || !strategy.startsWith(METRIC_STRATEGY_PREFIX)) {
    return null;
  }
  const id = strategy.slice(METRIC_STRATEGY_PREFIX.length);
  return id.length > 0 ? id : null;
}

// ---------------------------------------------------------------------------
// Goal — a typed view over a `hypothesis` knowledge row
//
// This is NOT a new persisted shape. It is a read projection the loop
// controller computes from a `hypothesis` row: the goal's identity is the row
// id, its KPI is parsed from `resolution_strategy`, its threshold + budget live
// in `tags` (see docs/design/knowledge-goal-loop.md § Goal representation).
// ---------------------------------------------------------------------------

export const GoalSchema = z.object({
  /** The `knowledge.id` of the `hypothesis` row this goal projects. */
  hypothesisId: z.string().min(1),
  /** Registered domain the goal + its evidence atoms live in. */
  domain: z.string().min(1),
  /** KPI identifier parsed from `resolution_strategy = metric:<kpi-id>`. */
  kpiId: z.string().min(1),
  /** Success threshold: the loop closes (validates) when `kpi >= target`. 0–100, same scale as confidence/KPI. */
  target: z.number().min(0).max(100),
  /** Appointment with truth — the row's `evaluate_at`. A hard wall-clock stop independent of budget. */
  evaluateAt: z.date(),
});
export type Goal = z.infer<typeof GoalSchema>;

// ---------------------------------------------------------------------------
// LoopBudget — the recursive-allotment guard (LOOP_TERMINATES)
//
// The simplest thing that provably terminates. Each value bounds one axis of
// runaway cost. The controller decrements/accumulates these per iteration and
// halts on the FIRST exhausted axis. MVP-stage: small caps, no autoscaling.
// ---------------------------------------------------------------------------

export const LoopBudgetSchema = z.object({
  /** Hard cap on loop iterations (Temporal-scheduled langgraph runs). v0 default kept low. */
  maxIterations: z.number().int().positive(),
  /** Cap on total LLM tokens across all iterations. Halts when the running sum would exceed. */
  maxTokens: z.number().int().positive(),
  /**
   * Max depth of spawned sub-goals (a goal whose evidence cites a child goal's
   * outcome). 0 = no recursion (single goal only). Bounds the EDO chain the
   * loop may grow, per EDO_RECURSION_VIA_CITATIONS.
   */
  maxRecursionDepth: z.number().int().min(0),
  /**
   * Consecutive iterations with no KPI gain before the loop halts early
   * (`no_progress` → invalidates). Stops a stuck goal from grinding to the
   * iteration/token cap. Frontier alignment: PRM "Progress" signal.
   */
  maxStalledIterations: z.number().int().positive(),
});
export type LoopBudget = z.infer<typeof LoopBudgetSchema>;

/**
 * v0 MVP defaults — barely-crawling, 1 dev, 0 users. Deliberately tiny so a
 * misconfigured goal burns cents, not dollars. Tune per-goal via `tags` only
 * when a real goal proves the defaults too small.
 */
export const DEFAULT_LOOP_BUDGET: LoopBudget = {
  maxIterations: 5,
  maxTokens: 200_000,
  maxRecursionDepth: 1,
  maxStalledIterations: 2,
};

// ---------------------------------------------------------------------------
// LoopState — what the controller carries across iterations (in-flight only).
//
// NOT persisted as its own row. Iteration history IS the EDO chain on the
// hypothesis (each step files evidence_for / a decision); this struct is the
// transient budget accounting the Temporal workflow threads through.
// ---------------------------------------------------------------------------

export const LoopHaltReasonSchema = z.enum([
  "goal_met", // kpi >= target → file outcome (validates)
  "evaluate_at_passed", // wall-clock wall hit → file outcome (invalidates)
  "no_progress", // KPI stalled for maxStalledIterations → file outcome (invalidates)
  "iterations_exhausted",
  "tokens_exhausted",
  "recursion_exhausted",
]);
export type LoopHaltReason = z.infer<typeof LoopHaltReasonSchema>;

export const LoopStateSchema = z.object({
  goal: GoalSchema,
  budget: LoopBudgetSchema,
  /** Iterations completed so far. */
  iterations: z.number().int().min(0),
  /** Tokens spent so far across iterations. */
  tokensSpent: z.number().int().min(0),
  /** Current recursion depth (0 at the root goal). */
  recursionDepth: z.number().int().min(0),
  /** Most recent KPI reading, 0–100; null before the first read. */
  lastKpi: z.number().min(0).max(100).nullable(),
  /** Consecutive iterations whose KPI read showed no gain over the prior. */
  stalledIterations: z.number().int().min(0),
});
export type LoopState = z.infer<typeof LoopStateSchema>;

/**
 * The pure termination predicate. Returns the halt reason if the loop MUST
 * stop before another iteration, or null to continue. Checked FIRST each tick
 * (LOOP_TERMINATES). `now` is injected so the check stays pure + testable.
 *
 * Order: goal-met wins over budget (a hit goal closes as validated even on the
 * last token); wall-clock wall next; then no-progress; then the three budget axes.
 */
export function loopHaltReason(
  state: LoopState,
  now: Date
): LoopHaltReason | null {
  if (state.lastKpi !== null && state.lastKpi >= state.goal.target) {
    return "goal_met";
  }
  if (now >= state.goal.evaluateAt) {
    return "evaluate_at_passed";
  }
  if (state.stalledIterations >= state.budget.maxStalledIterations) {
    return "no_progress";
  }
  if (state.iterations >= state.budget.maxIterations) {
    return "iterations_exhausted";
  }
  if (state.tokensSpent >= state.budget.maxTokens) {
    return "tokens_exhausted";
  }
  if (state.recursionDepth >= state.budget.maxRecursionDepth + 1) {
    return "recursion_exhausted";
  }
  return null;
}

/** The edge the loop files when it halts: a met goal `validates`, everything else `invalidates`. */
export function haltEdge(reason: LoopHaltReason): "validates" | "invalidates" {
  return reason === "goal_met" ? "validates" : "invalidates";
}

// ---------------------------------------------------------------------------
// Per-tick decision — the deterministic core the GoalLoopWorkflow wraps.
//
// Keeps the workflow's branch logic pure + unit-testable: given the state after
// reading the KPI, decide whether to halt (and with what reason/edge) or take
// one more step. The workflow does the I/O (read KPI, run graph step, file
// outcome); this function does the deciding.
// ---------------------------------------------------------------------------

/** Halt this tick: file the outcome with `edge`, then stop the schedule. */
export interface GoalLoopHaltDecision {
  kind: "halt";
  reason: LoopHaltReason;
  edge: "validates" | "invalidates";
}

/** Continue: take one research/cite step, then re-arm the next tick. */
export interface GoalLoopStepDecision {
  kind: "step";
}

export type GoalLoopDecision = GoalLoopHaltDecision | GoalLoopStepDecision;

/**
 * Decide what the controller does this tick. Runs the pure `loopHaltReason`
 * guard FIRST (LOOP_TERMINATES); on any halt reason it returns the matching
 * `haltEdge`, else it signals a step. `now` is injected so the decision stays
 * pure + testable without Temporal.
 */
export function goalLoopDecision(
  state: LoopState,
  now: Date
): GoalLoopDecision {
  const reason = loopHaltReason(state, now);
  if (reason !== null) {
    return { kind: "halt", reason, edge: haltEdge(reason) };
  }
  return { kind: "step" };
}

/**
 * Fold one completed step's accounting into `LoopState`: bump iterations, add
 * tokens, and track the no-progress streak (a step whose new KPI did not exceed
 * the prior reading is "stalled"). `recursionDepth` is threaded by the caller
 * (it changes only when a sub-goal is spawned), so it is passed through as-is.
 */
export function applyStep(
  state: LoopState,
  step: { tokensSpent: number; newKpi: number }
): LoopState {
  const prior = state.lastKpi;
  const gained = prior === null ? true : step.newKpi > prior;
  return {
    ...state,
    iterations: state.iterations + 1,
    tokensSpent: state.tokensSpent + step.tokensSpent,
    lastKpi: step.newKpi,
    stalledIterations: gained ? 0 : state.stalledIterations + 1,
  };
}
