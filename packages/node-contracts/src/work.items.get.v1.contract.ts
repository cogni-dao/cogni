// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/work.items.get.v1.contract`
 * Purpose: Defines operation contract for getting a single work item by ID.
 * Scope: Provides Zod schema and types for work item get wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 *   - Additive envelope (task.0118): `moves` entries carry metric, kpi and goal; `?include=links` adds `links`. Both derive from the one WorkItemDtoSchema.
 * Side-effects: none
 * Links: /api/v1/work/items/[id] route, https://node-template.cognidao.org/knowledge/work-items-port-contract
 * @internal
 */

import { z } from "zod";

import { WorkItemDtoSchema } from "./work.items.list.v1.contract";

/** Optional envelope parts a single-item read can add: `GET /api/v1/work/items/{id}?include=links`. */
export const WORK_ITEM_INCLUDES = ["links"] as const;

export const workItemsGetOperation = {
  id: "work.items.get.v1",
  summary: "Get a work item by ID",
  description:
    "Returns a single work item by its ID, or 404 if not found. Each moves entry carries its metric, the KPI it serves and the goal (task.0118). include=links adds the first page of citation links.",
  input: z.object({
    id: z.string(),
    include: z.array(z.enum(WORK_ITEM_INCLUDES)).optional(),
  }),
  output: WorkItemDtoSchema,
} as const;

// Export inferred types
export type WorkItemsGetInput = z.infer<typeof workItemsGetOperation.input>;
export type WorkItemsGetOutput = z.infer<typeof workItemsGetOperation.output>;
