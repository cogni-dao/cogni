// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/knowledge.contributions.v1.contract`
 * Purpose: HTTP request/response contract for the external-agent knowledge contribution flow.
 *   Mounted per-node at /api/v1/knowledge/contributions on every knowledge-capable node.
 * Scope: Zod schemas and types for the wire format. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 *   - Server stamps source_type='external' and source_ref='agent:<id>:<contribId>'
 *   - confidencePct is capped at 30 server-side for principal.kind==='agent'
 * Side-effects: none
 * Links: docs/design/knowledge-contribution-api.md, docs/spec/knowledge-data-plane.md, work/items/task.0425.knowledge-contribution-api.md
 * @internal
 */

import { z } from "zod";

const KnowledgeEntryInputSchema = z.object({
  domain: z.string().min(1).max(64),
  entityId: z.string().max(128).optional(),
  title: z.string().min(1).max(256),
  content: z.string().min(1).max(65536),
  entryType: z.string().min(1).max(64).optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
  confidencePct: z.number().int().min(0).max(100).optional(),
});

const ContributionStateSchema = z.enum(["open", "merged", "closed"]);

export const ContributionsCreateRequestSchema = z.object({
  message: z.string().min(1).max(512),
  entries: z.array(KnowledgeEntryInputSchema).min(1).max(50),
  idempotencyKey: z.string().min(8).max(64).optional(),
});
export type ContributionsCreateRequest = z.infer<
  typeof ContributionsCreateRequestSchema
>;

export const ContributionsListQuerySchema = z.object({
  state: z.enum(["open", "merged", "closed", "all"]).optional().default("open"),
  principalId: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});
export type ContributionsListQuery = z.infer<
  typeof ContributionsListQuerySchema
>;

export const ContributionMergeRequestSchema = z.object({
  confidencePct: z.number().int().min(30).max(95).optional(),
});
export type ContributionMergeRequest = z.infer<
  typeof ContributionMergeRequestSchema
>;

export const ContributionCloseRequestSchema = z.object({
  reason: z.string().min(1).max(512),
});
export type ContributionCloseRequest = z.infer<
  typeof ContributionCloseRequestSchema
>;

export const ContributionRecordSchema = z.object({
  contributionId: z.string(),
  branch: z.string(),
  commitHash: z.string(),
  state: ContributionStateSchema,
  principalKind: z.enum(["agent", "user"]),
  principalId: z.string(),
  message: z.string(),
  entryCount: z.number().int(),
  mergedCommit: z.string().nullable(),
  closedReason: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
});
export type ContributionRecord = z.infer<typeof ContributionRecordSchema>;

export const ContributionDiffEntrySchema = z.object({
  changeType: z.enum(["added", "modified", "removed"]),
  rowId: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
export type ContributionDiffEntry = z.infer<typeof ContributionDiffEntrySchema>;

export const ContributionsListResponseSchema = z.object({
  contributions: z.array(ContributionRecordSchema),
});
export type ContributionsListResponse = z.infer<
  typeof ContributionsListResponseSchema
>;

export const ContributionDiffResponseSchema = z.object({
  contributionId: z.string(),
  branch: z.string(),
  entries: z.array(ContributionDiffEntrySchema),
});
export type ContributionDiffResponse = z.infer<
  typeof ContributionDiffResponseSchema
>;

export const ContributionMergeResponseSchema = z.object({
  contributionId: z.string(),
  commitHash: z.string(),
});
export type ContributionMergeResponse = z.infer<
  typeof ContributionMergeResponseSchema
>;
