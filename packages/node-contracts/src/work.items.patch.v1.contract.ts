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
 *     `WorkItemCommandPort.patch(id, set)` (https://node-template.cognidao.org/knowledge/work-items-port-contract) — the operation
 *     is PATCH, the field being applied is `set`. The canonical wrapper is `set`, NOT
 *     `patch`. A mistaken `{ patch: {...} }` (guessed from the operation name) surfaces as
 *     an explicit `Unrecognized key: "patch"` issue instead of a silent-ignore that only
 *     reported `set: Required` — the confusing 400 that got bug.5242 misfiled as a drift.
 *   - OPTIONAL_CAS: top-level `expectedRevision` (the item's `revision` as read) is compare-and-set —
 *     the write lands only if the row is still at that revision, else 409 `revision_conflict` and
 *     nothing is written. Omitted ⇒ unconditioned patch (unchanged). No transition state-machine.
 *   - REASON_REQUIRED (task.0086): top-level `reason` is required: one line (line breaks become spaces), 1-240 chars,
 *     at most 25 words, stored in Dolt history and read back at GET /api/v1/work/items/{id}/history, never in the item
 *     (task.0052, story.0023). The package schema owns the rule; the adapter applies it again.
 *   - OPTIONAL_CITES (task.0086): top-level `cites` (at most 8 hub atoms) are pinned to commits in history; an unknown id is a 400.
 *     The package schema owns the cite rules.
 *   - MOVES_SERVER_PINS_BASELINE (story.0033): `set.moves` is `[{ metricId, direction }]`, at most 3, or `[]`; the shared schema drops any other key on an entry and the store pins the baseline.
 * Side-effects: none
 * Links: /api/v1/work/items/[id] route, https://node-template.cognidao.org/knowledge/work-items-port-contract, work/items/task.0423.doltgres-work-items-source-of-truth.md
 * @internal
 */

import {
  ChangeReasonSchema,
  WorkItemMovesInputSchema,
  WorkItemPatchInputSchema,
} from "@cogni/work-items";
import { z } from "zod";

import {
  WorkItemDtoSchema,
  WorkItemScoresInputSchema,
} from "./work.items.list.v1.contract";

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
    "fields only; id (path), created_at, updated_at are server-managed. Optional top-level " +
    "`expectedRevision` (integer, the item's `revision` as read) makes the write " +
    "compare-and-set: a moved row answers 409 errorCode `revision_conflict` with " +
    "`currentRevision` and nothing is written. Required `reason` (one line, at most 25 words and 240 chars) says why; " +
    "a PATCH without it is a 400. It is stored in history (GET /api/v1/work/items/{id}/history), not in the item. " +
    "Optional `cites` (at most 8, each { id } or { id, contribution }) name hub atoms you read; each is pinned to its " +
    "commit in history, and an unknown id is a 400.",
  input: z.strictObject({
    id: z.string(),
    expectedRevision: z.number().int().min(0).optional(),
    reason: ChangeReasonSchema,
    cites: WorkItemPatchInputSchema.shape.cites,
    set: z
      .strictObject({
        title: z.string().min(1).max(500).optional(),
        summary: z.string().optional(),
        outcome: z.string().optional(),
        status: WorkItemStatusSchema.optional(),
        priority: z.number().int().optional(),
        rank: z.number().int().optional(),
        estimate: z.number().int().optional(),
        // null clears the column back to SQL NULL (scores read as absent).
        scores: WorkItemScoresInputSchema.nullable().optional(),
        // story.0033: [] = this item moves no metric (the edit reason says why). The server pins each baseline.
        moves: WorkItemMovesInputSchema.optional(),
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
