// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/ai/evaluation-baseline`
 * Purpose: Bind published mission-loop contracts while preserving operator authorization metadata.
 * Scope: Node-owned composition only; no copied tool implementations or graph prompts.
 * Invariants:
 *   - HOST_POLICY_PRESERVED: every replaced contract keeps its existing operator requires gate.
 *   - RELEASE_OWNS_BEHAVIOR: the six baseline tool schemas come from the immutable tools release.
 *   - OTHER_TOOLS_UNCHANGED: product/VCS tools retain their existing bindings and runtime policy.
 * Side-effects: none
 * Links: hub adopt-node-package-release, story.5111
 * @internal
 */

import { type CatalogBoundTool, CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import { CORE_TOOL_BUNDLE as SHARED_TOOL_BUNDLE } from "@cogni/shared-ai-tools";
import { WorkItemPatchInputSchema } from "@cogni/work-items";
import { z } from "zod";

const baselineIds = new Set([
  "core__goal_list",
  "core__work_item_query",
  "core__work_item_update",
  "core__knowledge_search",
  "core__edo_decide",
  "core__get_current_time",
]);
const sharedById = new Map(
  SHARED_TOOL_BUNDLE.map((tool) => [tool.contract.name, tool])
);

const releasedSet = WorkItemPatchInputSchema.shape.set.shape;

/**
 * UPDATE_SURFACE_NARROWED (task.5448): the released `core__work_item_update` takes the whole PATCH `set` (title, outcome, pr, deployVerified,
 * projectId, parentId, any status). The retired transition tool let an agent change only priority, rank, labels, summary and scores, and move
 * a status. The operator keeps that surface plus the two statuses triage may route to; the store still gates every write.
 */
const updateSetSchema = z
  .strictObject({
    priority: releasedSet.priority,
    rank: releasedSet.rank,
    labels: releasedSet.labels,
    summary: releasedSet.summary,
    scores: releasedSet.scores,
    status: z.enum(["needs_research", "needs_design"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "set must contain at least one field",
  });

const narrowedUpdateInput = z.strictObject({
  id: WorkItemPatchInputSchema.shape.id,
  expectedRevision: WorkItemPatchInputSchema.shape.expectedRevision,
  reason: WorkItemPatchInputSchema.shape.reason,
  cites: WorkItemPatchInputSchema.shape.cites,
  set: updateSetSchema,
});

export const OPERATOR_CORE_TOOL_BUNDLE: readonly CatalogBoundTool[] =
  CORE_TOOL_BUNDLE.map((local) => {
    if (!baselineIds.has(local.contract.name)) return local;
    const shared = sharedById.get(local.contract.name);
    if (!shared)
      throw new Error(`Missing shared evaluation tool: ${local.contract.name}`);
    if (local.contract.requires === undefined) {
      throw new Error(
        `Missing operator policy for shared evaluation tool: ${local.contract.name}`
      );
    }
    return {
      ...shared,
      contract: {
        ...shared.contract,
        requires: local.contract.requires,
        ...(local.contract.name === "core__work_item_update" && {
          inputSchema: narrowedUpdateInput,
        }),
      },
    };
  });
