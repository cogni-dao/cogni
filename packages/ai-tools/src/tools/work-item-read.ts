// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/work-item-read`
 * Purpose: Read one complete work item through the existing query capability.
 * Scope: Exact-ID read only. Never clips an item's constraints or performs a write. Does not perform source mutations.
 * Invariants: Explicit failure on missing, ambiguous, or oversized source.
 * Side-effects: IO (work-item query).
 * Links: https://cognidao.org/work/items/task.5367
 * @public
 */
import { z } from "zod";
import type { WorkItemCapability } from "../capabilities/work-item";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";
import { WorkItemOutputSchema } from "./work-item-query";

export const WORK_ITEM_READ_NAME = "core__work_item_read" as const;
const inputSchema = z.object({ id: z.string().min(1) }).strict();
const outputSchema = z.object({
  complete: z.literal(true),
  item: WorkItemOutputSchema.extend({
    revision: z.number().int().nonnegative(),
  }),
});
type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;
export const workItemReadContract: ToolContract<
  typeof WORK_ITEM_READ_NAME,
  Input,
  Output,
  Output
> = {
  name: WORK_ITEM_READ_NAME,
  description:
    "Read one complete work item by exact ID, including full outcome and constraints. Required before proposing a next action for that item. Oversized sources fail explicitly; discovery excerpts are not full reads.",
  effect: "read_only",
  requires: "node.collaborate",
  inputSchema,
  outputSchema,
  redact: (output) => output,
  allowlist: ["complete", "item"],
};
export function createWorkItemReadImplementation(deps: {
  workItemCapability: WorkItemCapability;
}): ToolImplementation<Input, Output> {
  return {
    execute: async ({ id }) => {
      const items = await deps.workItemCapability.query({
        ids: [id],
        limit: 2,
      });
      if (items.length !== 1 || items[0]?.id !== id)
        throw new Error(
          "work_source_unavailable: exact item missing or ambiguous"
        );
      const item = WorkItemOutputSchema.parse(items[0]);
      if (!Number.isSafeInteger(item.revision))
        throw new Error(
          "work_source_revision_unavailable: exact item has no numeric revision"
        );
      if (new TextEncoder().encode(JSON.stringify(item)).length > 65536)
        throw new Error(
          "work_source_incomplete: item exceeds complete-read budget"
        );
      return outputSchema.parse({ complete: true, item });
    },
  };
}
export const workItemReadBoundTool: BoundTool<
  typeof WORK_ITEM_READ_NAME,
  Input,
  Output,
  Output
> = {
  contract: workItemReadContract,
  implementation: {
    execute: async () => {
      throw new Error("WorkItemCapability not configured");
    },
  },
};
