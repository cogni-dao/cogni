// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/work-item-update`
 * Purpose: The operator's policy shell for `core__work_item_update`, the successor of the retired `core__work_item_transition` (task.5448).
 * Scope: Contract plus a stub. Does not implement the tool. The runtime binds the released tool (`@cogni-dao/ai-tools` >= 0.15) over this contract's name and `requires`
 *   (`bootstrap/ai/evaluation-baseline`), so the input and output behaviour is the release's, not this file's.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__work_item_update`
 *   - EFFECT_TYPED: effect is `state_change`
 *   - NODE_COLLABORATE: `requires: "node.collaborate"`, the same tier as PATCH /api/v1/work/items/{id} and the tool this one replaces
 *   - MIRRORS_PATCH: the input is the PATCH route's own `WorkItemPatchInputSchema`; a status move is a `set.status` patch that the
 *     store gates (409 `gate_unmet`), never a second write path
 *   - CONFLICT_IS_A_RESULT: a lost compare-and-set or a refused gate is `{success:false, code, ...}`, so a graph can skip the row
 * Side-effects: none (stub)
 * Links: https://node-template.cognidao.org/knowledge/work-item-status-machine
 * @public
 */

import {
  WorkItemDtoSchema,
  type WorkItemPatchInput,
  WorkItemPatchInputSchema,
} from "@cogni/work-items";
import { z } from "zod";

import type { BoundTool, ToolContract, ToolImplementation } from "../types";

export const WORK_ITEM_UPDATE_NAME = "core__work_item_update" as const;

export const WorkItemUpdateInputSchema = WorkItemPatchInputSchema;
export type WorkItemUpdateInput = WorkItemPatchInput;

const WorkItemUpdateConflictSchema = z.object({
  success: z.literal(false),
  id: z.string(),
  code: z.literal("revision_conflict"),
  currentRevision: z.number().int(),
  message: z.string(),
});

const WorkItemUpdateGateSchema = z.object({
  success: z.literal(false),
  id: z.string(),
  code: z.enum(["gate_unmet", "gate_facts_unavailable"]),
  from: z.string(),
  to: z.string(),
  missing: z.string(),
  message: z.string(),
});

export const WorkItemUpdateOutputSchema = z.union([
  WorkItemDtoSchema,
  WorkItemUpdateConflictSchema,
  WorkItemUpdateGateSchema,
]);
export type WorkItemUpdateOutput = z.infer<typeof WorkItemUpdateOutputSchema>;

export const workItemUpdateContract: ToolContract<
  typeof WORK_ITEM_UPDATE_NAME,
  WorkItemUpdateInput,
  WorkItemUpdateOutput,
  WorkItemUpdateOutput
> = {
  name: WORK_ITEM_UPDATE_NAME,
  description:
    "Update a work item: the same operation as PATCH /api/v1/work/items/{id}. Input { id, expectedRevision?, reason, cites?, set }. " +
    "Use core__work_item_query first to find items and read their revision.",
  effect: "state_change",
  requires: "node.collaborate",
  inputSchema: WorkItemUpdateInputSchema,
  outputSchema: WorkItemUpdateOutputSchema,
  redact: (output) => output,
  allowlist: [
    ...Object.keys(WorkItemDtoSchema.shape),
    "success",
    "code",
    "currentRevision",
    "from",
    "to",
    "missing",
    "message",
  ] as unknown as ReadonlyArray<keyof WorkItemUpdateOutput>,
};

export const workItemUpdateStubImplementation: ToolImplementation<
  WorkItemUpdateInput,
  WorkItemUpdateOutput
> = {
  execute: async (): Promise<WorkItemUpdateOutput> => {
    throw new Error("WorkItemCapability not configured.");
  },
};

export const workItemUpdateBoundTool: BoundTool<
  typeof WORK_ITEM_UPDATE_NAME,
  WorkItemUpdateInput,
  WorkItemUpdateOutput,
  WorkItemUpdateOutput
> = {
  contract: workItemUpdateContract,
  implementation: workItemUpdateStubImplementation,
};
