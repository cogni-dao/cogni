// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/work.items.patch.v1.contract`
 * Purpose: Operation contract for patching a work item via the operator API.
 * Scope: Provides Zod schema and types for work item patch wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 *   - PATCH_ALLOWLIST: only fields in `set` are mutable. id/created_at/updated_at are server-managed.
 *   - STRICT_WRAPPER: the payload wrapper is `{ set: {...} }` and the top level is strict.
 *     `set` is the SQL-style UPDATE…SET envelope and mirrors the domain port
 *     `WorkItemCommandPort.patch(id, set)` (docs/spec/work-items-port.md) — the operation
 *     is PATCH, the field being applied is `set`. The canonical wrapper is `set`, NOT
 *     `patch`. A mistaken `{ patch: {...} }` (guessed from the operation name) surfaces as
 *     an explicit `Unrecognized key: "patch"` issue instead of a silent-ignore that only
 *     reported `set: Required` — the confusing 400 that got bug.5242 misfiled as a drift.
 *   - v0 has no expectedRevision optimistic concurrency and no transition state-machine — whoever holds a valid token is trusted.
 * Side-effects: none
 * Links: /api/v1/work/items/[id] route, docs/spec/work-items-port.md, work/items/task.0423.doltgres-work-items-source-of-truth.md
 * @internal
 */

import { z } from "zod";

import { WorkItemDtoSchema } from "./work.items.list.v1.contract";

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

export const workItemsPatchOperation = {
  id: "work.items.patch.v1",
  summary: "Patch a work item",
  description:
    "Updates a subset of fields on a work item. HTTP: PATCH /api/v1/work/items/{id} " +
    "with body { set: { <field>: <value>, ... } } — the SQL-style UPDATE…SET envelope. " +
    "The operation is PATCH but the payload wrapper is `set`, NOT `patch`. Whitelisted " +
    "fields only; id (path), created_at, updated_at are server-managed. v0 has no expectedRevision.",
  input: z.strictObject({
    id: z.string(),
    set: z
      .strictObject({
        title: z.string().min(1).max(500).optional(),
        summary: z.string().optional(),
        outcome: z.string().optional(),
        status: WorkItemStatusSchema.optional(),
        priority: z.number().int().optional(),
        rank: z.number().int().optional(),
        estimate: z.number().int().optional(),
        labels: z.array(z.string()).optional(),
        specRefs: z.array(z.string()).optional(),
        branch: z.string().optional(),
        pr: z.string().optional(),
        reviewer: z.string().optional(),
        node: z.string().optional(),
        deployVerified: z.boolean().optional(),
        projectId: z.string().nullable().optional(),
        parentId: z.string().nullable().optional(),
        blockedBy: z.string().nullable().optional(),
      })
      .refine((v) => Object.keys(v).length > 0, {
        message: "set must contain at least one field",
      }),
  }),
  output: WorkItemDtoSchema,
} as const;

// Export inferred types
export type WorkItemsPatchInput = z.infer<typeof workItemsPatchOperation.input>;
export type WorkItemsPatchOutput = z.infer<
  typeof workItemsPatchOperation.output
>;
