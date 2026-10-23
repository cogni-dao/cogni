// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/knowledge-read`
 * Purpose: AI tool for reading knowledge entries by ID or listing by domain + tags.
 * Scope: Read-only retrieval. Does not write or commit.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__knowledge_read`
 *   - EFFECT_TYPED: effect is `read_only`
 *   - HARD_BOUNDS: max 50 results for list mode
 * Side-effects: IO (database read via capability)
 * Links: docs/spec/knowledge-data-plane.md
 * @public
 */

import { z } from "zod";

import type { KnowledgeCapability } from "../capabilities/knowledge";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const KnowledgeReadInputSchema = z
  .object({
    id: z
      .string()
      .optional()
      .describe("Get a specific entry by ID (mutually exclusive with domain)"),
    domain: z
      .string()
      .optional()
      .describe("List entries by domain (mutually exclusive with id)"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Filter by tags (only with domain mode)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max results for list mode (1-50, default 20)"),
    includeEdo: z
      .boolean()
      .optional()
      .describe(
        "List mode only: include EDO rows (event/hypothesis/decision/outcome); default false"
      ),
  })
  .refine((d) => d.id || d.domain, {
    message: "Either 'id' or 'domain' is required",
  });
export type KnowledgeReadInput = z.infer<typeof KnowledgeReadInputSchema>;

export const KnowledgeReadEntrySchema = z.object({
  id: z.string(),
  domain: z.string(),
  entityId: z.string().nullable(),
  title: z.string(),
  content: z.string(),
  confidencePct: z.number().nullable(),
  sourceType: z.string(),
  sourceRef: z.string().nullable(),
  tags: z.array(z.string()).nullable(),
});

export const KnowledgeReadOutputSchema = z.object({
  mode: z.enum(["get", "list"]),
  entries: z.array(KnowledgeReadEntrySchema),
  totalFound: z.number(),
});
export type KnowledgeReadOutput = z.infer<typeof KnowledgeReadOutputSchema>;
export type KnowledgeReadRedacted = KnowledgeReadOutput;

// ─── Contract ────────────────────────────────────────────────────────────────

export const KNOWLEDGE_READ_NAME = "core__knowledge_read" as const;

export const knowledgeReadContract: ToolContract<
  typeof KNOWLEDGE_READ_NAME,
  KnowledgeReadInput,
  KnowledgeReadOutput,
  KnowledgeReadRedacted
> = {
  name: KNOWLEDGE_READ_NAME,
  description:
    "Read knowledge entries from the node's knowledge store. " +
    "Use with 'id' to get a specific entry, or 'domain' to list entries (optionally filtered by tags). " +
    "Each entry includes a confidence score (0-100): 30=draft, 80=verified, 95+=hardened.",
  effect: "read_only",
  requires: "node.collaborate",
  inputSchema: KnowledgeReadInputSchema,
  outputSchema: KnowledgeReadOutputSchema,
  redact: (output) => output,
  allowlist: ["mode", "entries", "totalFound"] as const,
};

// ─── Implementation ──────────────────────────────────────────────────────────

export interface KnowledgeReadDeps {
  knowledgeCapability: KnowledgeCapability;
}

export function createKnowledgeReadImplementation(
  deps: KnowledgeReadDeps
): ToolImplementation<KnowledgeReadInput, KnowledgeReadOutput> {
  return {
    execute: async (input) => {
      if (input.id) {
        const entry = await deps.knowledgeCapability.get(input.id);
        return {
          mode: "get" as const,
          entries: entry
            ? [
                {
                  id: entry.id,
                  domain: entry.domain,
                  entityId: entry.entityId,
                  title: entry.title,
                  content: entry.content,
                  confidencePct: entry.confidencePct,
                  sourceType: entry.sourceType,
                  sourceRef: entry.sourceRef,
                  tags: entry.tags,
                },
              ]
            : [],
          totalFound: entry ? 1 : 0,
        };
      }

      // After the `if (input.id)` early return, the Zod refine guarantees domain is defined
      const domain = input.domain ?? "";
      const entries = await deps.knowledgeCapability.list({
        domain,
        tags: input.tags,
        limit: input.limit ?? 20,
        ...(input.includeEdo ? { includeEdo: true } : {}),
      });
      return {
        mode: "list" as const,
        entries: entries.map((e) => ({
          id: e.id,
          domain: e.domain,
          entityId: e.entityId,
          title: e.title,
          content: e.content,
          confidencePct: e.confidencePct,
          sourceType: e.sourceType,
          sourceRef: e.sourceRef,
          tags: e.tags,
        })),
        totalFound: entries.length,
      };
    },
  };
}

export const knowledgeReadStubImplementation: ToolImplementation<
  KnowledgeReadInput,
  KnowledgeReadOutput
> = {
  execute: async () => {
    throw new Error(
      "KnowledgeCapability not configured. Knowledge store access not available."
    );
  },
};

// ─── Bound Tool ──────────────────────────────────────────────────────────────

export const knowledgeReadBoundTool: BoundTool<
  typeof KNOWLEDGE_READ_NAME,
  KnowledgeReadInput,
  KnowledgeReadOutput,
  KnowledgeReadRedacted
> = {
  contract: knowledgeReadContract,
  implementation: knowledgeReadStubImplementation,
};
