// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/work.items.create.v1.contract`
 * Purpose: Operation contract for creating a new work item via the operator API. Server allocates ID in the reserved 5000+ range (task.0423).
 * Scope: Provides Zod schema and types for work item create wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 *   - ID is server-allocated by default; client-supplied `id` is allowed for ID-preserving bulk imports (legacy markdown corpus → Doltgres). Server validates the format and rejects collisions with existing rows.
 *   - status defaults to "needs_triage" if not provided
 *   - node defaults to "shared"
 *   - PRIORITY_RANGE: `priority` is an integer 0..99 (0 = highest), the same bound as the
 *     core__work_item_transition tool. 0 and 1 additionally require node admin (route gate).
 * Side-effects: none
 * Links: /api/v1/work/items route, docs/spec/work-items-port.md, work/items/task.0423.doltgres-work-items-source-of-truth.md
 * @internal
 */

import { z } from "zod";

import { WorkItemDtoSchema } from "./work.items.list.v1.contract";

const SubjectRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string() }),
  z.object({ kind: z.literal("agent"), agentId: z.string() }),
  z.object({ kind: z.literal("system"), serviceId: z.string() }),
]);

const WorkItemTypeSchema = z.enum(["task", "bug", "story", "spike", "subtask"]);

const WorkItemStatusSchema = z.enum([
  "needs_triage",
  "needs_research",
  "needs_design",
  "needs_implement",
  "needs_closeout",
  "needs_merge",
  "done",
  "blocked",
  "cancelled",
]);

export const workItemsCreateOperation = {
  id: "work.items.create.v1",
  summary: "Create a new work item",
  description:
    "Creates a new work item in operator's Doltgres knowledge_operator database. Server allocates an ID in the reserved 5000+ range per type (e.g. task.5000+). Returns the full created row.",
  input: z.object({
    id: z
      .string()
      .regex(/^(task|bug|story|spike|subtask)\.\d{4,}$/)
      .optional(),
    type: WorkItemTypeSchema,
    title: z.string().min(1).max(500),
    summary: z.string().optional(),
    outcome: z.string().optional(),
    status: WorkItemStatusSchema.optional(),
    node: z.string().optional(),
    projectId: z.string().optional(),
    parentId: z.string().optional(),
    // PRIORITY_RANGE (task.5294): 0 is highest. Values below 0 would outrank every
    // p0, so the wire refuses them; same bound as core__work_item_transition.
    priority: z.number().int().min(0).max(99).optional(),
    rank: z.number().int().optional(),
    estimate: z.number().int().optional(),
    labels: z.array(z.string()).optional(),
    specRefs: z.array(z.string()).optional(),
    assignees: z.array(SubjectRefSchema).optional(),
  }),
  output: WorkItemDtoSchema,
} as const;

// Export inferred types
export type WorkItemsCreateInput = z.infer<
  typeof workItemsCreateOperation.input
>;
export type WorkItemsCreateOutput = z.infer<
  typeof workItemsCreateOperation.output
>;
