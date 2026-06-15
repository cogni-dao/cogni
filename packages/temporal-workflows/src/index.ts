// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows`
 * Purpose: Public type exports ONLY — safe to import from any runtime (app, worker, tests).
 * Scope: Re-exports types, pure constants, and domain functions. Does not export workflow functions (use subpath exports).
 * Invariants:
 *   - Per SUBPATH_ISOLATION: this barrel exports types only (plus pure domain functions), never workflow functions
 *   - Safe to import from Next.js app code without pulling in @temporalio/workflow
 * Side-effects: none
 * Links: docs/spec/packages-architecture.md
 * @public
 */

// Activity profiles (shared timeout/retry configs)
export {
  EXTERNAL_API_ACTIVITY_OPTIONS,
  GRAPH_EXECUTION_ACTIVITY_OPTIONS,
  STANDARD_ACTIVITY_OPTIONS,
} from "./activity-profiles.js";
// Activity type interfaces
export type {
  EnrichmentActivities,
  GoalLoopActivities,
  GoalWire,
  LedgerActivities,
  LoopBudgetWire,
  ReviewActivities,
  SchedulerActivities,
  SweepActivities,
  SweepWorkItem,
} from "./activity-types.js";
// Domain types (review)
export type {
  EvaluationOutput,
  EvidenceBundle,
  GateResult,
  GateStatus,
  ReviewResult,
} from "./domain/review.js";
// Domain functions (review — pure, deterministic)
export {
  aggregateGateStatuses,
  buildReviewUserMessage,
  evaluateCriteria,
  findRequirement,
  formatCheckRunSummary,
  formatCrossDomainRefusal,
  formatNoScopeNeutral,
  formatPrComment,
  formatThreshold,
} from "./domain/review.js";
export type { AttributionIngestRunV1 } from "./workflows/collect-epoch.workflow.js";
export type { FinalizeEpochWorkflowInput } from "./workflows/finalize-epoch.workflow.js";
// Workflow input/output types
export {
  DEFAULT_GOAL_STEP_GRAPH_ID,
  type GoalLoopWorkflowInput,
  GoalLoopWorkflowInputSchema,
} from "./workflows/goal-loop.schema.js";
export type { GoalLoopResult } from "./workflows/goal-loop.workflow.js";
export type {
  GraphRunResult,
  GraphRunWorkflowInput,
} from "./workflows/graph-run.workflow.js";
export {
  type PrReviewWorkflowInput,
  PrReviewWorkflowInputSchema,
} from "./workflows/pr-review.schema.js";
export type { CollectSourcesInput } from "./workflows/stages/collect-sources.workflow.js";
export type { EnrichAndAllocateInput } from "./workflows/stages/enrich-and-allocate.workflow.js";
