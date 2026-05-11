// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/schemas`
 * Purpose: Zod schemas and TypeScript types for the knowledge data plane.
 * Scope: Pure validation schemas. Does not contain I/O or side effects.
 * Invariants: SCHEMA_GENERIC_CONTENT_SPECIFIC — domain specificity in `domain` field + `tags`, not schema structure.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md
 * @public
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Source types
// ---------------------------------------------------------------------------

export const SourceTypeSchema = z.enum([
  "human",
  "analysis_signal",
  "external",
  "derived",
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

// ---------------------------------------------------------------------------
// Entry type — what KIND of knowledge a row represents within its domain.
// The DB column is plain `text` (default 'finding'); this enum is the
// recommended set per docs/spec/knowledge-syntropy.md § Seed Schema. Adding
// values here is a doc + UI change, not a schema migration.
// ---------------------------------------------------------------------------

export const EntryTypeSchema = z.enum([
  "observation",
  "finding",
  "conclusion",
  "rule",
  "scorecard",
  "skill",
  "guide",
  "design-visual",
]);
export type EntryType = z.infer<typeof EntryTypeSchema>;

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export const KnowledgeSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  entityId: z.string().nullable().optional(),
  title: z.string().min(1),
  content: z.string().min(1),
  entryType: z.string().min(1).optional(),
  confidencePct: z.number().int().min(0).max(100).nullable().optional(),
  sourceType: SourceTypeSchema,
  sourceRef: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  createdAt: z.date().optional(),
});

export type Knowledge = z.infer<typeof KnowledgeSchema>;

export const NewKnowledgeSchema = KnowledgeSchema.omit({ createdAt: true });
export type NewKnowledge = z.infer<typeof NewKnowledgeSchema>;

// ---------------------------------------------------------------------------
// Dolt versioning types
// ---------------------------------------------------------------------------

export const DoltCommitSchema = z.object({
  commitHash: z.string(),
  committer: z.string(),
  email: z.string().optional(),
  date: z.date().or(z.string()),
  message: z.string(),
});

export type DoltCommit = z.infer<typeof DoltCommitSchema>;

export const DoltDiffEntrySchema = z.object({
  diffType: z.enum(["added", "modified", "removed"]),
  fromId: z.string().nullable().optional(),
  toId: z.string().nullable().optional(),
  fromTitle: z.string().nullable().optional(),
  toTitle: z.string().nullable().optional(),
});

export type DoltDiffEntry = z.infer<typeof DoltDiffEntrySchema>;
