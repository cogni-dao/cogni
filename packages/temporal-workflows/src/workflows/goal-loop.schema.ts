// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/workflows/goal-loop.schema`
 * Purpose: Zod schema for `GoalLoopWorkflowInput` — the single source of truth for the goal-loop workflow's input shape; a goal is a controller wrapped around ANY graph (the step graph is a goal-level field, default `langgraph:research`).
 * Scope: Schema definition + `z.infer<>` type export. Does not contain business logic, runtime I/O, or side-effects.
 * Invariants:
 *   - SINGLE_INPUT_CONTRACT: this `.strict()` schema is the single source of
 *     truth; producers parse with it before `workflowClient.start(...)`, the
 *     workflow consumes the inferred type via `z.infer<>`.
 *   - GOAL_IS_GRAPH_AGNOSTIC: `stepGraphId` is goal-level config (any graph can
 *     be driven by a goal), defaulting to `langgraph:research`.
 * Side-effects: none
 * Links: docs/design/knowledge-goal-loop.md, docs/spec/temporal-patterns.md
 * @public
 */

import { z } from "zod";

/** Default step graph a goal drives when none is configured (reused, not new). */
export const DEFAULT_GOAL_STEP_GRAPH_ID = "langgraph:research" as const;

/**
 * Workflow input contract for `GoalLoopWorkflow`. Populated at
 * schedule-registration time from the goal hypothesis row (keyed on
 * `hypothesisId`). `.strict()` so a typo'd field rejects at parse time rather
 * than silently passing a malformed object over Temporal's wire.
 */
export const GoalLoopWorkflowInputSchema = z
  .object({
    /** Owning node (routes the goal-loop activities' HTTP delegation). */
    nodeId: z.string().min(1),
    /** The `knowledge.id` of the goal hypothesis this loop drives. */
    hypothesisId: z.string().min(1),
    /**
     * Graph the per-tick step runs. A goal is a controller wrapped around ANY
     * graph — default `research`, but any registered graph id is valid. Format
     * `provider:name` (e.g. `langgraph:research`).
     */
    stepGraphId: z
      .string()
      .regex(/^[a-z0-9_-]+:[a-z0-9_-]+$/)
      .default(DEFAULT_GOAL_STEP_GRAPH_ID),
  })
  .strict();

/**
 * Inferred TS type for `GoalLoopWorkflow`'s input.
 *
 * Per SINGLE_INPUT_CONTRACT: never duplicate this shape as a separate
 * interface — import the type and let the Zod schema be the source of truth.
 */
export type GoalLoopWorkflowInput = z.infer<typeof GoalLoopWorkflowInputSchema>;
