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
 *   - Server stamps branch edits with source_ref='contribution:<id>:<seq>'
 *   - confidencePct is capped at 30 server-side for principal.kind==='agent'
 * Side-effects: none
 * Links: docs/design/knowledge-contribution-api.md, docs/spec/knowledge-data-plane.md, work/items/task.0425.knowledge-contribution-api.md
 * @internal
 */

import {
  ContributionCommitRecordSchema,
  ContributionDiffEntrySchema,
  ContributionRecordSchema,
  KnowledgeContributionEditSchema,
} from "@cogni/knowledge-store/contribution-schemas";
import { z } from "zod";

export const ContributionsCreateRequestSchema = z.object({
  message: z.string().min(1).max(512),
  edits: z.array(KnowledgeContributionEditSchema).min(1).max(50).optional(),
  idempotencyKey: z.string().min(8).max(64).optional(),
});
export type ContributionsCreateRequest = z.infer<
  typeof ContributionsCreateRequestSchema
>;

export const ContributionAppendCommitRequestSchema = z.object({
  message: z.string().min(1).max(512),
  edits: z.array(KnowledgeContributionEditSchema).min(1).max(50),
});
export type ContributionAppendCommitRequest = z.infer<
  typeof ContributionAppendCommitRequestSchema
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

export type ContributionRecord = z.infer<typeof ContributionRecordSchema>;

export type ContributionCommitRecord = z.infer<
  typeof ContributionCommitRecordSchema
>;

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

export const ContributionCommitsResponseSchema = z.object({
  contributionId: z.string(),
  commits: z.array(ContributionCommitRecordSchema),
});
export type ContributionCommitsResponse = z.infer<
  typeof ContributionCommitsResponseSchema
>;

export const ContributionMergeResponseSchema = z.object({
  contributionId: z.string(),
  commitHash: z.string(),
});
export type ContributionMergeResponse = z.infer<
  typeof ContributionMergeResponseSchema
>;
