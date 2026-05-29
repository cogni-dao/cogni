// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/schemas`
 * Purpose: Zod schemas and TypeScript types for the knowledge data plane.
 * Scope: Pure validation schemas. Does not contain I/O or side effects.
 * Invariants: SCHEMA_GENERIC_CONTENT_SPECIFIC — domain specificity in `domain` field + `tags`, not schema structure.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md, docs/spec/knowledge-syntropy.md
 * @public
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Source types
// ---------------------------------------------------------------------------

export const SourceTypeSchema = z.enum([
  "human",
  "agent",
  "analysis_signal",
  "external",
  "derived",
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

// ---------------------------------------------------------------------------
// Entry type — what KIND of knowledge a row represents within its domain.
// The DB column is plain `text` (default 'finding'); this enum is the
// recommended set per docs/spec/knowledge-syntropy.md § Seed Schema +
// § The Hypothesis Loop. Adding values here is a doc + UI change, not a
// schema migration.
// ---------------------------------------------------------------------------

export const EntryTypeSchema = z.enum([
  // Four-beat hypothesis loop (codename EDO; see knowledge-syntropy.md)
  "event",
  "hypothesis",
  "decision",
  "outcome",
  // Non-temporal knowledge
  "observation",
  "finding",
  "conclusion",
  "rule",
  "scorecard",
  "skill",
  "guide",
  "html",
]);
export type EntryType = z.infer<typeof EntryTypeSchema>;

/**
 * Entry types that MUST go through atomic `core__edo_*` tools.
 * `core__knowledge_write` rejects rows whose `entry_type` is in this set.
 * `event` is deliberately NOT in the set — events have no required citations
 * and flow through `core__knowledge_write` unchanged.
 */
export const RAW_WRITE_REJECTS_TYPES: readonly EntryType[] = [
  "hypothesis",
  "decision",
  "outcome",
];

// ---------------------------------------------------------------------------
// Citation type — relationship between two knowledge rows
// ---------------------------------------------------------------------------

export const CitationTypeSchema = z.enum([
  // Non-temporal knowledge edges
  "supports",
  "contradicts",
  "extends",
  "supersedes",
  // Hypothesis loop edges (see knowledge-syntropy.md § The Hypothesis Loop)
  "evidence_for", // event/observation/finding → hypothesis (or decision)
  "derives_from", // decision → hypothesis (strict)
  "validates", // outcome → hypothesis (strict)
  "invalidates", // outcome → hypothesis (strict)
]);
export type CitationType = z.infer<typeof CitationTypeSchema>;

/**
 * Citation types that MUST point at a hypothesis row. The adapter's
 * `EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE` check enforces this.
 */
export const HYPOTHESIS_TARGETED_EDGES: readonly CitationType[] = [
  "derives_from",
  "validates",
  "invalidates",
];

// ---------------------------------------------------------------------------
// Resolution strategy — namespaced text on hypothesis rows
//
// NULL = no automation (cron skips). Non-null = resolver kind. v0 ships
// with `agent` only; future kinds (market:<id>, metric:<query>, http:<url>,
// deadline) add new values, not new columns.
// ---------------------------------------------------------------------------

export const ResolutionStrategySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[a-z][a-z0-9_]*(:[A-Za-z0-9_./~^-]+)?$/,
    "resolution_strategy must be a namespaced identifier: 'agent' | 'kind:<value>' (e.g. market:0x123)"
  );
export type ResolutionStrategy = z.infer<typeof ResolutionStrategySchema>;

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
  evaluateAt: z.date().nullable().optional(),
  resolutionStrategy: z.string().nullable().optional(),
  createdAt: z.date().optional(),
});

export type Knowledge = z.infer<typeof KnowledgeSchema>;

export const NewKnowledgeSchema = KnowledgeSchema.omit({ createdAt: true });
export type NewKnowledge = z.infer<typeof NewKnowledgeSchema>;

// ---------------------------------------------------------------------------
// Citation — edge in the knowledge DAG
// ---------------------------------------------------------------------------

export const CitationSchema = z.object({
  id: z.string().min(1),
  citingId: z.string().min(1),
  citedId: z.string().min(1),
  citationType: CitationTypeSchema,
  context: z.string().nullable().optional(),
  createdAt: z.date().optional(),
});

export type Citation = z.infer<typeof CitationSchema>;

export const NewCitationSchema = CitationSchema.omit({
  id: true,
  createdAt: true,
}).extend({
  id: z.string().min(1).optional(), // server-derivable when omitted
});

export type NewCitation = z.infer<typeof NewCitationSchema>;

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
