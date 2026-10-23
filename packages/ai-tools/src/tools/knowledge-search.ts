// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/knowledge-search`
 * Purpose: AI tool for searching the node's knowledge store by domain + text query.
 * Scope: Read-only search with structured results. Does not write or commit.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__knowledge_search`
 *   - EFFECT_TYPED: effect is `read_only`
 *   - HARD_BOUNDS: max 20 results
 *   - BOUNDED_RESULTS: each result's `content` is truncated to KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS (≤20 hits ×
 *     1500 chars), so one call can never return a multi-MB entry (bug.5518)
 * Side-effects: IO (database read via capability)
 * Links: docs/spec/knowledge-data-plane.md
 * @public
 */

import { z } from "zod";

import type { KnowledgeCapability } from "../capabilities/knowledge";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const KnowledgeSearchInputSchema = z.object({
  domain: z
    .string()
    .min(1)
    .describe(
      "Knowledge domain to search (e.g., 'prediction-market', 'infrastructure', 'meta')"
    ),
  query: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Text query — matches against title and content (case-insensitive)"
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum results (1-20, default 10)"),
  includeEdo: z
    .boolean()
    .optional()
    .describe(
      "include EDO rows (event/hypothesis/decision/outcome); default false"
    ),
});
export type KnowledgeSearchInput = z.infer<typeof KnowledgeSearchInputSchema>;

export const KnowledgeSearchResultSchema = z.object({
  id: z.string(),
  domain: z.string(),
  title: z.string(),
  content: z.string(),
  confidencePct: z.number().nullable(),
  sourceType: z.string(),
  tags: z.array(z.string()).nullable(),
});

export const KnowledgeSearchOutputSchema = z.object({
  query: z.string(),
  domain: z.string(),
  results: z.array(KnowledgeSearchResultSchema),
  totalFound: z.number(),
});
export type KnowledgeSearchOutput = z.infer<typeof KnowledgeSearchOutputSchema>;
export type KnowledgeSearchRedacted = KnowledgeSearchOutput;

// ─── Contract ────────────────────────────────────────────────────────────────

export const KNOWLEDGE_SEARCH_NAME = "core__knowledge_search" as const;

export const knowledgeSearchContract: ToolContract<
  typeof KNOWLEDGE_SEARCH_NAME,
  KnowledgeSearchInput,
  KnowledgeSearchOutput,
  KnowledgeSearchRedacted
> = {
  name: KNOWLEDGE_SEARCH_NAME,
  description:
    "Search the node's knowledge store for domain-specific facts, claims, and curated assertions. " +
    "Returns entries with confidence scores and provenance. Search BEFORE using web search — " +
    "the knowledge store contains verified, curated information relevant to this node's domain.",
  effect: "read_only",
  requires: "node.collaborate",
  inputSchema: KnowledgeSearchInputSchema,
  outputSchema: KnowledgeSearchOutputSchema,
  redact: (output) => output,
  allowlist: ["query", "domain", "results", "totalFound"] as const,
};

// ─── Implementation ──────────────────────────────────────────────────────────

/** BOUNDED_RESULTS: max chars of each result's `content` (bug.5518). */
export const KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS = 1500;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface KnowledgeSearchDeps {
  knowledgeCapability: KnowledgeCapability;
}

export function createKnowledgeSearchImplementation(
  deps: KnowledgeSearchDeps
): ToolImplementation<KnowledgeSearchInput, KnowledgeSearchOutput> {
  return {
    execute: async (input) => {
      const results = await deps.knowledgeCapability.search({
        domain: input.domain,
        query: input.query,
        limit: input.limit ?? 10,
        ...(input.includeEdo ? { includeEdo: true } : {}),
      });
      return {
        query: input.query,
        domain: input.domain,
        results: results.map((r) => ({
          id: r.id,
          domain: r.domain,
          title: r.title,
          content: truncate(r.content, KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS),
          confidencePct: r.confidencePct,
          sourceType: r.sourceType,
          tags: r.tags,
        })),
        totalFound: results.length,
      };
    },
  };
}

export const knowledgeSearchStubImplementation: ToolImplementation<
  KnowledgeSearchInput,
  KnowledgeSearchOutput
> = {
  execute: async () => {
    throw new Error(
      "KnowledgeCapability not configured. Knowledge store access not available."
    );
  },
};

// ─── Bound Tool ──────────────────────────────────────────────────────────────

export const knowledgeSearchBoundTool: BoundTool<
  typeof KNOWLEDGE_SEARCH_NAME,
  KnowledgeSearchInput,
  KnowledgeSearchOutput,
  KnowledgeSearchRedacted
> = {
  contract: knowledgeSearchContract,
  implementation: knowledgeSearchStubImplementation,
};
