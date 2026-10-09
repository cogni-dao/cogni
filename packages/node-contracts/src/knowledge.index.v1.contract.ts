// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/knowledge.index.v1.contract`
 * Purpose: HTTP contract for GET /api/v1/knowledge/index — the routing projection. Returns id + retrieval trigger + type per entry, WITHOUT content, so an agent can pick a shelf entry without downloading bodies.
 * Scope: Read-only query + response shapes. Does not perform IO and does not define behaviour.
 * Invariants:
 *   - INDEX_CARRIES_NO_CONTENT — the response must never include `content`; that is the whole point of the endpoint.
 *   - Q_MATCHES_USEWHEN_ONLY — `q` filters on the retrieval trigger and nothing else. It does not search titles or bodies; full-text browse is a different endpoint.
 * Side-effects: none
 * Links: knowledge entry `cogni-domain-taxonomy`, packages/node-contracts/src/knowledge.list.v1.contract.ts
 * @internal
 */

import { z } from "zod";

export const KnowledgeIndexQuerySchema = z.object({
  domain: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(1000).optional().default(500),
  /**
   * Q_MATCHES_USEWHEN_ONLY — case-insensitive substring of the retrieval
   * trigger. This is what makes `useWhen` readable rather than write-only: a
   * caller can ask which triggers match its situation in one call, without
   * downloading any bodies (task.5204). Deliberately NOT added to
   * `GET /knowledge`: that endpoint browses rows, this one routes, and two
   * endpoints with sharp jobs beat one with modes.
   */
  q: z.string().min(1).max(320).optional(),
});
export type KnowledgeIndexQuery = z.infer<typeof KnowledgeIndexQuerySchema>;

/**
 * One routing row. Deliberately NOT a subset of `KnowledgeRowSchema`: this is a
 * distinct purpose-built shape, so widening the browse DTO cannot silently
 * widen the index and reintroduce content on the wire.
 */
export const KnowledgeIndexRowSchema = z.object({
  id: z.string(),
  domain: z.string(),
  entryType: z.string(),
  /** The retrieval trigger — the reader's situation. Null until backfilled. */
  useWhen: z.string().nullable(),
});
export type KnowledgeIndexRow = z.infer<typeof KnowledgeIndexRowSchema>;

export const KnowledgeIndexResponseSchema = z.object({
  items: z.array(KnowledgeIndexRowSchema),
  domains: z.array(z.string()),
  /** Total rows considered, so a caller can detect a truncating `limit`. */
  total: z.number().int(),
});
export type KnowledgeIndexResponse = z.infer<
  typeof KnowledgeIndexResponseSchema
>;
