// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/knowledge-write`
 * Purpose: AI tool for writing knowledge entries + auto-commit.
 * Scope: Writes a single knowledge entry and commits the change. Does not handle branching or bulk imports.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__knowledge_write`
 *   - EFFECT_TYPED: effect is `state_change`
 *   - AUTO_COMMIT: Every write creates a Doltgres commit automatically.
 *   - CONFIDENCE_DEFAULTS: New entries default to 30% (draft).
 * Side-effects: IO (database write + dolt_commit via capability)
 * Links: docs/spec/knowledge-data-plane.md
 * @public
 */

import { z } from "zod";

import {
  CONFIDENCE,
  type KnowledgeCapability,
} from "../capabilities/knowledge";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const KnowledgeWriteInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Unique ID for this knowledge entry (deterministic or human-readable, e.g., 'fed-rate-base-rate-2026')"
    ),
  domain: z
    .string()
    .min(1)
    .describe("Knowledge domain (e.g., 'prediction-market', 'infrastructure')"),
  title: z
    .string()
    .min(1)
    .max(500)
    .describe("Human-readable summary of the knowledge claim"),
  content: z
    .string()
    .min(1)
    .describe(
      "The knowledge claim or fact — be specific, include evidence or reasoning"
    ),
  sourceType: z
    .enum(["human", "analysis_signal", "external", "derived"])
    .describe(
      "Origin: human=manually curated, analysis_signal=from analysis pipeline, external=from external source, derived=computed from other knowledge"
    ),
  entityId: z
    .string()
    .optional()
    .describe("Optional stable subject key (e.g., a market ID, entity name)"),
  confidencePct: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Confidence 0-100. Defaults to 30 (draft). 80=verified, 95+=hardened."
    ),
  sourceRef: z
    .string()
    .optional()
    .describe("Pointer to source (URL, paper DOI, signal ID, analysis run ID)"),
  tags: z
    .array(z.string())
    .optional()
    .describe("Searchable tags for categorization"),
});
export type KnowledgeWriteInput = z.infer<typeof KnowledgeWriteInputSchema>;

export const KnowledgeWriteOutputSchema = z.object({
  entry: z.object({
    id: z.string(),
    domain: z.string(),
    title: z.string(),
    confidencePct: z.number().nullable(),
    sourceType: z.string(),
    tags: z.array(z.string()).nullable(),
  }),
  committed: z.boolean(),
  message: z.string(),
});
export type KnowledgeWriteOutput = z.infer<typeof KnowledgeWriteOutputSchema>;
export type KnowledgeWriteRedacted = KnowledgeWriteOutput;

// ─── Contract ────────────────────────────────────────────────────────────────

export const KNOWLEDGE_WRITE_NAME = "core__knowledge_write" as const;

export const knowledgeWriteContract: ToolContract<
  typeof KNOWLEDGE_WRITE_NAME,
  KnowledgeWriteInput,
  KnowledgeWriteOutput,
  KnowledgeWriteRedacted
> = {
  name: KNOWLEDGE_WRITE_NAME,
  description:
    "Write a knowledge entry to the node's knowledge store and auto-commit. " +
    "Use this to persist curated facts, research findings, or analysis results. " +
    "New entries default to 30% confidence (draft). " +
    "Include a sourceRef (URL, DOI, signal ID) for provenance tracking. " +
    "Every write creates a versioned Doltgres commit automatically.",
  effect: "state_change",
  inputSchema: KnowledgeWriteInputSchema,
  outputSchema: KnowledgeWriteOutputSchema,
  redact: (output) => output,
  allowlist: ["entry", "committed", "message"] as const,
};

// ─── Implementation ──────────────────────────────────────────────────────────

export interface KnowledgeWriteDeps {
  knowledgeCapability: KnowledgeCapability;
}

export function createKnowledgeWriteImplementation(
  deps: KnowledgeWriteDeps
): ToolImplementation<KnowledgeWriteInput, KnowledgeWriteOutput> {
  return {
    execute: async (input) => {
      // v0 write-pipeline gates (shape + provenance) are enforced inside the
      // capability layer (createKnowledgeCapability), so this tool stays
      // dependency-thin on @cogni/ai-tools. The capability throws
      // KnowledgeGateError if a gate rejects, which surfaces to the agent
      // as a tool error.
      const entry = await deps.knowledgeCapability.write({
        id: input.id,
        domain: input.domain,
        title: input.title,
        content: input.content,
        sourceType: input.sourceType,
        entityId: input.entityId,
        confidencePct: input.confidencePct ?? CONFIDENCE.DRAFT,
        sourceRef: input.sourceRef,
        tags: input.tags,
      });

      return {
        entry: {
          id: entry.id,
          domain: entry.domain,
          title: entry.title,
          confidencePct: entry.confidencePct,
          sourceType: entry.sourceType,
          tags: entry.tags,
        },
        committed: true,
        message: `Knowledge '${entry.id}' written and committed (confidence: ${entry.confidencePct ?? CONFIDENCE.DRAFT}%)`,
      };
    },
  };
}

export const knowledgeWriteStubImplementation: ToolImplementation<
  KnowledgeWriteInput,
  KnowledgeWriteOutput
> = {
  execute: async () => {
    throw new Error(
      "KnowledgeCapability not configured. Knowledge store access not available."
    );
  },
};

// ─── Bound Tool ──────────────────────────────────────────────────────────────

export const knowledgeWriteBoundTool: BoundTool<
  typeof KNOWLEDGE_WRITE_NAME,
  KnowledgeWriteInput,
  KnowledgeWriteOutput,
  KnowledgeWriteRedacted
> = {
  contract: knowledgeWriteContract,
  implementation: knowledgeWriteStubImplementation,
};
