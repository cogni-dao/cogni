// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/contribution-schemas`
 * Purpose: Zod schemas for the external-agent knowledge contribution flow.
 * Scope: Pure validation schemas used by port, adapter, service, and HTTP contracts. Does not contain I/O, business logic, or framework dependencies.
 * Invariants: EXTERNAL_CONTRIB_VIA_BRANCH (per knowledge-data-plane spec).
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
  entryType: z.string().min(1).max(64).optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
  confidencePct: z.number().int().min(0).max(100).optional(),
});
export type KnowledgeEntryInput = z.infer<typeof KnowledgeEntryInputSchema>;

export const KnowledgeContributionEditSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("insert"), entry: KnowledgeEntryInputSchema }),
  z.object({
    op: z.literal("update"),
    targetRowId: z.string().min(1).max(256),
    entry: KnowledgeEntryInputSchema,
  }),
  z.object({
    op: z.literal("deprecate"),
    targetRowId: z.string().min(1).max(256),
    reason: z.string().min(1).max(512),
  }),
]);
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
  changeType: z.enum(["added", "modified", "removed"]),
  rowId: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
export type ContributionDiffEntry = z.infer<typeof ContributionDiffEntrySchema>;
