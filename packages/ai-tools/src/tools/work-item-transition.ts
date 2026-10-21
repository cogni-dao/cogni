// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/work-item-transition`
 * Purpose: AI tool for transitioning work item status and patching fields.
 * Scope: State-changing work item mutations via WorkItemCapability. Does not import LangChain.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__work_item_transition`
 *   - EFFECT_TYPED: effect is `state_change`
 *   - NO_ONEOF_IN_SCHEMA: Uses flat z.object per tool-use.md #10
 *   - TRANSITION_TABLE_ENFORCED: Capability validates transitions via development-lifecycle.md
 *   - PATCH_CAS_OPTIONAL: patch `expectedRevision` is compare-and-set; absent ⇒ unconditioned patch (unchanged)
 *   - CONFLICT_IS_A_RESULT: a lost compare-and-set returns `{success:false, code:"revision_conflict",
 *     currentRevision}` instead of throwing, so a graph can skip the row and retry next cycle
 * Side-effects: IO (mutates work items via capability)
 * Links: docs/spec/development-lifecycle.md, docs/spec/tool-use.md
 * @public
 */

import { z } from "zod";

import {
  type WorkItemCapability,
  WorkItemPatchConflictError,
} from "../capabilities/work-item";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flat object schema for work item transitions.
 *
 * Per tool-use.md #10: inputSchema must compile to JSON Schema `type: "object"`.
 * action enum + all fields optional; implementation validates per-action.
 */
export const WorkItemTransitionInputSchema = z.object({
  action: z
    .enum(["transition", "patch"])
    .describe(
      "Action: 'transition' changes status, 'patch' updates fields (priority, rank, labels, summary)"
    ),
  id: z
    .string()
    .min(1)
    .describe("Work item ID (e.g., 'task.0149', 'bug.0150')"),
  toStatus: z
    .enum([
      "needs_triage",
      "needs_research",
      "needs_design",
      "needs_implement",
      "needs_closeout",
      "needs_merge",
      "done",
      "blocked",
      "cancelled",
    ])
    .optional()
    .describe("Target status (required for transition action)"),
  reason: z
    .string()
    .optional()
    .describe("Reason for the transition — recorded in audit trail"),
  priority: z
    .number()
    .int()
    .min(0)
    .max(99)
    .optional()
    .describe("Priority (0=highest, used for patch action)"),
  rank: z
    .number()
    .int()
    .optional()
    .describe(
      "Rank within the backlog (lower = sooner, used for patch action)"
    ),
  labels: z
    .array(z.string())
    .optional()
    .describe("Labels to set (used for patch action)"),
  summary: z
    .string()
    .optional()
    .describe("Summary to set (used for patch action)"),
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Patch only: the item's revision you read. The patch lands only if the item is " +
        "still at this revision; otherwise nothing is written and the result is " +
        "success=false, code='revision_conflict' with currentRevision. Omit for an unconditioned patch."
    ),
});
export type WorkItemTransitionInput = z.infer<
  typeof WorkItemTransitionInputSchema
>;

export const WorkItemTransitionOutputSchema = z.object({
  success: z.boolean(),
  action: z.string(),
  id: z.string(),
  message: z.string(),
  previousStatus: z.string().optional(),
  newStatus: z.string().optional(),
  /** Item revision after a successful patch. */
  revision: z.number().int().optional(),
  /** Set when success=false: `revision_conflict` = the CAS lost, nothing written. */
  code: z.literal("revision_conflict").optional(),
  /** On `revision_conflict`: the revision the item is actually at. */
  currentRevision: z.number().int().optional(),
});
export type WorkItemTransitionOutput = z.infer<
  typeof WorkItemTransitionOutputSchema
>;

export type WorkItemTransitionRedacted = WorkItemTransitionOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

export const WORK_ITEM_TRANSITION_NAME = "core__work_item_transition" as const;

export const workItemTransitionContract: ToolContract<
  typeof WORK_ITEM_TRANSITION_NAME,
  WorkItemTransitionInput,
  WorkItemTransitionOutput,
  WorkItemTransitionRedacted
> = {
  name: WORK_ITEM_TRANSITION_NAME,
  description:
    "Modify a work item. Actions: " +
    "'transition' (requires id + toStatus, optional reason) changes the item's lifecycle status, " +
    "'patch' (requires id, optional priority/rank/labels/summary, optional expectedRevision for compare-and-set) updates metadata fields. " +
    "Use core__work_item_query first to find items and check their current status.",
  effect: "state_change",
  inputSchema: WorkItemTransitionInputSchema,
  outputSchema: WorkItemTransitionOutputSchema,

  redact: (output: WorkItemTransitionOutput): WorkItemTransitionRedacted =>
    output,
  allowlist: [
    "success",
    "action",
    "id",
    "message",
    "previousStatus",
    "newStatus",
    "revision",
    "code",
    "currentRevision",
  ] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkItemTransitionDeps {
  readonly workItemCapability: WorkItemCapability;
}

export function createWorkItemTransitionImplementation(
  deps: WorkItemTransitionDeps
): ToolImplementation<WorkItemTransitionInput, WorkItemTransitionOutput> {
  const { workItemCapability } = deps;

  return {
    execute: async (
      input: WorkItemTransitionInput
    ): Promise<WorkItemTransitionOutput> => {
      switch (input.action) {
        case "transition": {
          if (!input.toStatus) {
            throw new Error("toStatus is required for action 'transition'");
          }
          if (input.expectedRevision !== undefined) {
            throw new Error(
              "expectedRevision is only supported for action 'patch'"
            );
          }
          const result = await workItemCapability.transitionStatus({
            id: input.id,
            toStatus: input.toStatus,
            reason: input.reason,
          });
          return {
            success: true,
            action: "transition",
            id: result.id,
            message: `Transitioned ${result.id} from ${result.previousStatus} to ${result.newStatus}`,
            previousStatus: result.previousStatus,
            newStatus: result.newStatus,
          };
        }
        case "patch": {
          const setFields: {
            priority?: number;
            rank?: number;
            labels?: string[];
            summary?: string;
          } = {};
          if (input.priority !== undefined) setFields.priority = input.priority;
          if (input.rank !== undefined) setFields.rank = input.rank;
          if (input.labels !== undefined) setFields.labels = input.labels;
          if (input.summary !== undefined) setFields.summary = input.summary;

          if (Object.keys(setFields).length === 0) {
            throw new Error(
              "At least one field (priority, rank, labels, or summary) is required for action 'patch'"
            );
          }

          let result: Awaited<ReturnType<WorkItemCapability["patch"]>>;
          try {
            result = await workItemCapability.patch({
              id: input.id,
              ...(input.expectedRevision !== undefined && {
                expectedRevision: input.expectedRevision,
              }),
              set: setFields,
            });
          } catch (e) {
            if (!(e instanceof WorkItemPatchConflictError)) throw e;
            return {
              success: false,
              action: "patch",
              id: input.id,
              code: "revision_conflict",
              currentRevision: e.currentRevision,
              message: `Not patched: ${input.id} is at revision ${e.currentRevision}, expected ${e.expectedRevision}. Nothing was written; re-read and retry.`,
            };
          }
          return {
            success: true,
            action: "patch",
            id: result.id,
            message: `Patched ${result.id}: updated ${Object.keys(setFields).join(", ")}`,
            ...(result.revision !== undefined && { revision: result.revision }),
          };
        }
      }
    },
  };
}

export const workItemTransitionStubImplementation: ToolImplementation<
  WorkItemTransitionInput,
  WorkItemTransitionOutput
> = {
  execute: async (): Promise<WorkItemTransitionOutput> => {
    throw new Error("WorkItemCapability not configured.");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Bound Tool
// ─────────────────────────────────────────────────────────────────────────────

export const workItemTransitionBoundTool: BoundTool<
  typeof WORK_ITEM_TRANSITION_NAME,
  WorkItemTransitionInput,
  WorkItemTransitionOutput,
  WorkItemTransitionRedacted
> = {
  contract: workItemTransitionContract,
  implementation: workItemTransitionStubImplementation,
};
