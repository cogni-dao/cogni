// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/knowledge.list.v1.contract`
 * Purpose: HTTP request/response contract for browsing the knowledge plane.
 *   Mounted per-node at GET /api/v1/knowledge on every knowledge-capable node.
 * Scope: Zod schemas and types for the wire format. Does not contain business logic, I/O, or auth policy.
 * Invariants:
 *   - KNOWLEDGE_READ_REQUIRES_PRINCIPAL (any authenticated principal — session human or bearer agent).
 *   - Response shape mirrors `Knowledge` domain type from `@cogni/knowledge-store`.
 * Side-effects: none
 * Links: docs/spec/knowledge-syntropy.md
 * @internal
 */

import { z } from "zod";

export const KnowledgeListQuerySchema = z.object({
  domain: z.string().min(1).max(64).optional(),
  sourceType: z
    .enum(["human", "analysis_signal", "external", "derived", "agent"])
    .optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
});
export type KnowledgeListQuery = z.infer<typeof KnowledgeListQuerySchema>;

export const KnowledgeRowSchema = z.object({
  id: z.string(),
  domain: z.string(),
  entityId: z.string().nullable(),
  title: z.string(),
  content: z.string(),
  entryType: z.string(),
  confidencePct: z.number().int().nullable(),
  sourceType: z.string(),
  sourceRef: z.string().nullable(),
  tags: z.array(z.string()).nullable(),
  createdAt: z.string().nullable(),
});
export type KnowledgeRow = z.infer<typeof KnowledgeRowSchema>;

export const KnowledgeListResponseSchema = z.object({
  items: z.array(KnowledgeRowSchema),
  domains: z.array(z.string()),
});
export type KnowledgeListResponse = z.infer<typeof KnowledgeListResponseSchema>;
