// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/work.items.list.v1.contract`
 * Purpose: Defines operation contract for listing work items with optional filters.
 * Scope: Provides Zod schema and types for work item list wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 * Side-effects: none
 * Links: /api/v1/work/items route, docs/spec/work-items-port.md
 * @internal
 */

import { z } from "zod";

const SubjectRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string() }),
  z.object({ kind: z.literal("agent"), agentId: z.string() }),
  z.object({ kind: z.literal("system"), serviceId: z.string() }),
]);

const ExternalRefSchema = z.object({
  system: z.string(),
  kind: z.string(),
  externalId: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
});

/**
 * Do-it-now scores (story.5111): axis id → { v: int 0–5, ev?: evidence URL }.
 * Axis ids are config (hub `work-item-scores-design`), so keys are an open,
 * bounded string set rather than an enum. Writes replace the whole object.
 *
 * SCORES_ONE_ENFORCER: this schema is only the OpenAPI-visible outline and
 * states no bounds. Every bound (axis-id pattern, ≤12 axes, integer 0–5,
 * SCORE_NEEDS_EVIDENCE, https `ev` on the node's allow-list, ≤300 chars,
 * ≤1 KB) is `parseWorkItemScores` from `@cogni-dao/work-items`, run by the
 * Doltgres adapter with the node's ONE configured evidence-host list; the
 * facade maps its `WorkItemScoresInvalidError` to HTTP 400. Validating here
 * too would need a second copy of that list. `looseObject` keeps unknown
 * entry keys so the package validator rejects them.
 */
export const WorkItemScoresInputSchema = z.record(
  z.string(),
  z.looseObject({ v: z.number(), ev: z.string().optional() })
);

const WorkItemScoresDtoSchema = z.record(
  z.string(),
  z.object({ v: z.number(), ev: z.string().optional() })
);

export const WorkItemDtoSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.number().optional(),
  rank: z.number().optional(),
  estimate: z.number().optional(),
  scores: WorkItemScoresDtoSchema.optional(),
  summary: z.string().optional(),
  outcome: z.string().optional(),
  projectId: z.string().optional(),
  parentId: z.string().optional(),
  node: z.string().optional(),
  assignees: z.array(SubjectRefSchema),
  externalRefs: z.array(ExternalRefSchema),
  actor: z.string().optional(),
  labels: z.array(z.string()),
  specRefs: z.array(z.string()),
  branch: z.string().optional(),
  pr: z.string().optional(),
  reviewer: z.string().optional(),
  revision: z.number(),
  blockedBy: z.string().optional(),
  deployVerified: z.boolean(),
  claimedByRun: z.string().optional(),
  claimedAt: z.string().optional(),
  lastCommand: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const workItemsListOperation = {
  id: "work.items.list.v1",
  summary: "List work items with optional filters",
  description:
    "Returns work items matching optional type, status, text, and project filters.",
  input: z.object({
    types: z.array(z.string()).optional(),
    statuses: z.array(z.string()).optional(),
    text: z.string().optional(),
    actor: z.enum(["human", "ai", "either"]).optional(),
    projectId: z.string().optional(),
    node: z.union([z.string(), z.array(z.string())]).optional(),
    limit: z.number().int().positive().max(500).optional(),
    cursor: z.string().optional(),
  }),
  output: z.object({
    items: z.array(WorkItemDtoSchema),
    /** @deprecated Use pageInfo.endCursor — kept for backwards compat. */
    nextCursor: z.string().optional(),
    pageInfo: z
      .object({
        endCursor: z.string().nullable(),
        hasMore: z.boolean(),
      })
      .optional(),
  }),
} as const;

// Export inferred types
export type WorkItemDto = z.infer<typeof WorkItemDtoSchema>;
export type WorkItemsListInput = z.infer<typeof workItemsListOperation.input>;
export type WorkItemsListOutput = z.infer<typeof workItemsListOperation.output>;
