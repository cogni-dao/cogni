// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/contribution-schemas`
 * Purpose: Zod schemas for the external-agent knowledge contribution flow.
 * Scope: Pure validation schemas used by port, adapter, service, and HTTP contracts. Does not contain I/O, business logic, or framework dependencies.
 * Invariants:
 *   - EXTERNAL_CONTRIB_VIA_BRANCH (per knowledge-data-plane spec).
 *   - PATCH_CARRIES_NO_CONTENT: the `patch` op's partial has no `content` and no
 *     `domain` field at all, so a metadata refinement is structurally incapable
 *     of overwriting a body or moving a shelf. This is load-bearing, not an
 *     oversight — see `KnowledgeEntryPatchSchema`.
 *   - PATCH_IS_NOT_EMPTY: a `patch` with no settable field is a typed
 *     validation error, never a silent no-op write.
 * Side-effects: none
 * Links: docs/design/knowledge-contribution-api.md
 * @public
 */

import { z } from "zod";

export const PrincipalKindSchema = z.enum(["agent", "user"]);
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>;

export const PrincipalSchema = z.object({
  id: z.string().min(1),
  kind: PrincipalKindSchema,
  role: z.string().optional(),
  name: z.string().optional(),
});
export type Principal = z.infer<typeof PrincipalSchema>;

export const KnowledgeEntryInputSchema = z.object({
  id: z.string().min(1).max(256).optional(),
  domain: z.string().min(1).max(64),
  entityId: z.string().max(128).optional(),
  title: z.string().min(1).max(256),
  content: z.string().min(1).max(65536),
  useWhen: z.string().min(1).max(320).optional(),
  entryType: z.string().min(1).max(64).optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
});
export type KnowledgeEntryInput = z.infer<typeof KnowledgeEntryInputSchema>;

/**
 * The `patch` op's partial. Every field is optional and the destructive ones are
 * ABSENT FROM THE SHAPE, not merely optional:
 *
 *   - **`content` is excluded on purpose (PATCH_CARRIES_NO_CONTENT).** Refining
 *     a retrieval trigger is the most frequent intended edit; before this op the
 *     only way to do it was `op:'update'`, which requires a full
 *     `KnowledgeEntryInputSchema` and therefore replays up to 64 KiB of body —
 *     so any drift or truncation in that resend silently clobbered `content`.
 *     Keeping the field out of the type means no `patch`, however stale or
 *     malformed, can reach the `content` column. Replacing a body stays
 *     `op:'update'`, where the caller is explicitly stating that intent.
 *   - **`domain` is excluded too.** Moving an entry between shelves is a
 *     different, separately reviewable decision; it is not a side-effect of
 *     sharpening a trigger. Use `op:'update'` for that.
 *
 * `z.strictObject` so an unknown key — notably a hopeful `content` — is a loud
 * 400 instead of being dropped, which would let a caller believe a body write
 * landed when it never could.
 */
export const KnowledgeEntryPatchSchema = z.strictObject({
  useWhen: z.string().min(1).max(320).optional(),
  title: z.string().min(1).max(256).optional(),
  entryType: z.string().min(1).max(64).optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
});
export type KnowledgeEntryPatch = z.infer<typeof KnowledgeEntryPatchSchema>;

/** The fields a `patch` may set. Single source for the empty-partial check. */
export const KNOWLEDGE_ENTRY_PATCH_FIELDS = [
  "useWhen",
  "title",
  "entryType",
  "tags",
] as const satisfies readonly (keyof KnowledgeEntryPatch)[];

/** True when a parsed patch names at least one field to set. */
export function knowledgeEntryPatchIsEmpty(
  patch: KnowledgeEntryPatch
): boolean {
  return KNOWLEDGE_ENTRY_PATCH_FIELDS.every(
    (field) => patch[field] === undefined
  );
}

/**
 * Citation edge types writable through the generic contribution flow. These
 * are the non-temporal knowledge edges from `CitationTypeSchema` (domain
 * `schemas.ts`); the hypothesis-loop edges (`evidence_for`, `derives_from`,
 * `validates`, `invalidates`) are deliberately excluded — those carry the
 * `EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE` hypothesis-target invariant and stay
 * behind the dedicated `/api/v1/edo/*` endpoints. Keeping the primitive
 * (a typed `citing → cited` edge) and only widening which types a generic
 * contribution may write is the reuse-over-bespoke choice.
 */
export const ContributionCitationTypeSchema = z.enum([
  "supports",
  "contradicts",
  "extends",
  "supersedes",
  "tracks",
]);
export type ContributionCitationType = z.infer<
  typeof ContributionCitationTypeSchema
>;

export const KnowledgeContributionEditSchema = z
  .discriminatedUnion("op", [
    z.object({ op: z.literal("insert"), entry: KnowledgeEntryInputSchema }),
    z.object({
      op: z.literal("update"),
      targetRowId: z.string().min(1).max(256),
      entry: KnowledgeEntryInputSchema,
    }),
    z.object({
      op: z.literal("patch"),
      targetRowId: z.string().min(1).max(256),
      entry: KnowledgeEntryPatchSchema,
    }),
    z.object({
      op: z.literal("delete"),
      targetRowId: z.string().min(1).max(256),
      reason: z.string().min(1).max(512),
    }),
    z.object({
      op: z.literal("cite"),
      citingId: z.string().min(1).max(256),
      citedId: z.string().min(1).max(256),
      citationType: ContributionCitationTypeSchema,
      context: z.string().max(512).optional(),
    }),
  ])
  .superRefine((edit, ctx) => {
    // PATCH_IS_NOT_EMPTY: `{op:'patch', entry:{}}` parses structurally (every
    // field is optional) but would issue an UPDATE with no SET clause. Reject
    // it at the wire so the caller gets a typed 400 naming the settable
    // fields, rather than a 200 for a write that never happened.
    if (edit.op === "patch" && knowledgeEntryPatchIsEmpty(edit.entry)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `patch must set at least one of: ${KNOWLEDGE_ENTRY_PATCH_FIELDS.join(", ")}. A patch deliberately cannot carry content or domain — use op:'update' to replace a body or move a shelf.`,
        path: ["entry"],
      });
    }
    // A self-referential edge would let a row support/contradict its own
    // confidence — reject at the wire rather than in the adapter.
    if (edit.op === "cite" && edit.citingId === edit.citedId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cite edge cannot be self-referential (citingId === citedId)",
        path: ["citedId"],
      });
    }
  });
export type KnowledgeContributionEdit = z.infer<
  typeof KnowledgeContributionEditSchema
>;

export const ContributionStateSchema = z.enum(["open", "merged", "closed"]);
export type ContributionState = z.infer<typeof ContributionStateSchema>;

export const ContributionRecordSchema = z.object({
  contributionId: z.string(),
  branch: z.string(),
  baseCommit: z.string(),
  headCommit: z.string().nullable(),
  commitCount: z.number().int(),
  state: ContributionStateSchema,
  principalKind: PrincipalKindSchema,
  principalId: z.string(),
  message: z.string(),
  mergedCommit: z.string().nullable(),
  closedReason: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
});
export type ContributionRecord = z.infer<typeof ContributionRecordSchema>;

export const ContributionCommitRecordSchema = z.object({
  contributionId: z.string(),
  seq: z.number().int(),
  commitHash: z.string(),
  principalKind: PrincipalKindSchema,
  principalId: z.string(),
  authSource: z.enum(["bearer", "session"]),
  message: z.string(),
  editCount: z.number().int(),
  sourceRef: z.string(),
  createdAt: z.string(),
});
export type ContributionCommitRecord = z.infer<
  typeof ContributionCommitRecordSchema
>;

export const ContributionDiffEntrySchema = z.object({
  // `citation_*` make links first-class in the diff: a `cite` edit writes to the
  // separate `citations` table, so without these it was invisible — and its
  // confidence-recompute side-effect on the CITED entry surfaced as a phantom
  // `modified` with no visible change (bug.5004). `before`/`after` for a citation
  // entry carry `{citingId, citedId, citationType}`, not a knowledge row.
  changeType: z.enum([
    "added",
    "modified",
    "removed",
    "citation_added",
    "citation_removed",
  ]),
  rowId: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
export type ContributionDiffEntry = z.infer<typeof ContributionDiffEntrySchema>;
