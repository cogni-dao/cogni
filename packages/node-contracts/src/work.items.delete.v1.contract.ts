// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/work.items.delete.v1.contract`
 * Purpose: Operation contract for hard-deleting a work item via the operator API.
 * Scope: Provides Zod schema and types for work item delete wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 *   - HARD_DELETE: row is removed from work_items; recovery via dolt_revert on the deletion commit
 *   - AUTHOR_ATTRIBUTED: author handle embedded in the dolt_log commit message
 * Side-effects: none
 * Links: /api/v1/work/items/[id] route, https://node-template.cognidao.org/knowledge/work-items-port-contract
 * @internal
 */

import { z } from "zod";

export const workItemsDeleteOperation = {
  id: "work.items.delete.v1",
  summary: "Delete a work item by ID",
  description:
    "Hard-deletes a work item from the operator Doltgres store. The deletion is captured in dolt_log with the actor handle, so recovery via dolt_revert remains possible.",
  input: z.object({
    id: z.string(),
  }),
  output: z.object({
    id: z.string(),
    deleted: z.literal(true),
  }),
} as const;

export type WorkItemsDeleteInput = z.infer<
  typeof workItemsDeleteOperation.input
>;
export type WorkItemsDeleteOutput = z.infer<
  typeof workItemsDeleteOperation.output
>;
