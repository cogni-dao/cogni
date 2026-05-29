// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/edo-hypothesize`
 * Purpose: AI tool contract for filing a falsifiable hypothesis row with evaluate_at and N evidence_for citations atomically.
 * Scope: Tool contract + stub + bound tool definition. Does not contain implementations of the underlying ports.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__edo_hypothesize`
 *   - EFFECT_TYPED: effect is `state_change`
 *   - HYPOTHESIS_HAS_EVALUATE_AT: evaluateAt is required by the Zod schema.
 *   - EDO_TOOLS_ATOMIC: write + edges + commit happen in one capability call.
 * Side-effects: IO (database write + dolt_commit via capability)
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import { z } from "zod";

import type { EdoCapability } from "../capabilities/edo";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const EdoHypothesizeInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Unique ID for this hypothesis (e.g., 'pm:fed-rate-cut-march-2026')"
    ),
  domain: z.string().min(1).describe("Registered knowledge domain"),
  title: z.string().min(1).max(500).describe("One-line falsifiable prediction"),
  content: z
    .string()
    .min(1)
    .describe(
      "Full hypothesis — the prediction, the reasoning, the expected outcome"
    ),
  evaluateAt: z
    .string()
    .datetime()
    .describe(
      "ISO timestamp — when this hypothesis should be resolved (the appointment with truth). REQUIRED."
    ),
  resolutionStrategy: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Namespaced resolver identifier. Omit (or 'manual') = cron skips; only humans resolve. 'agent' = cron hands off to a resolver graph. Future: 'market:<id>', 'metric:<query>', 'http:<url>', 'deadline'."
    ),
  evidenceForIds: z
    .array(z.string())
    .optional()
    .describe(
      "IDs of event/observation/finding rows that motivate this prediction. One evidence_for citation will be written per id."
    ),
  sourceType: z
    .enum(["human", "agent", "analysis_signal", "external", "derived"])
    .describe("Where this hypothesis came from"),
  sourceRef: z.string().optional(),
  sourceNode: z.string().optional(),
  tags: z.array(z.string()).optional(),
  confidencePct: z.number().int().min(0).max(100).optional(),
});
export type EdoHypothesizeInput = z.infer<typeof EdoHypothesizeInputSchema>;

export const EdoHypothesizeOutputSchema = z.object({
  entry: z.object({
    id: z.string(),
    domain: z.string(),
    title: z.string(),
    confidencePct: z.number().nullable(),
    sourceType: z.string(),
  }),
  evaluateAt: z.string(),
  resolutionStrategy: z.string().nullable(),
  evidenceCitationCount: z.number(),
  committed: z.boolean(),
  message: z.string(),
});
export type EdoHypothesizeOutput = z.infer<typeof EdoHypothesizeOutputSchema>;
export type EdoHypothesizeRedacted = EdoHypothesizeOutput;

// ─── Contract ────────────────────────────────────────────────────────────────

export const EDO_HYPOTHESIZE_NAME = "core__edo_hypothesize" as const;

export const edoHypothesizeContract: ToolContract<
  typeof EDO_HYPOTHESIZE_NAME,
  EdoHypothesizeInput,
  EdoHypothesizeOutput,
  EdoHypothesizeRedacted
> = {
  name: EDO_HYPOTHESIZE_NAME,
  description:
    "File a falsifiable hypothesis with evaluate_at + evidence citations + auto-commit. " +
    "Use this whenever you make a prediction. evaluateAt is the appointment with truth — " +
    "the resolver cron (or a human, if resolutionStrategy is omitted) files the outcome at that time " +
    "and your confidence updates mechanically. Bypassing this tool by writing entry_type='hypothesis' " +
    "via core__knowledge_write is rejected.",
  effect: "state_change",
  inputSchema: EdoHypothesizeInputSchema,
  outputSchema: EdoHypothesizeOutputSchema,
  redact: (output) => output,
  allowlist: [
    "entry",
    "evaluateAt",
    "resolutionStrategy",
    "evidenceCitationCount",
    "committed",
    "message",
  ] as const,
};

// ─── Implementation ──────────────────────────────────────────────────────────

export interface EdoHypothesizeDeps {
  edoCapability: EdoCapability;
}

export function createEdoHypothesizeImplementation(
  deps: EdoHypothesizeDeps
): ToolImplementation<EdoHypothesizeInput, EdoHypothesizeOutput> {
  return {
    execute: async (input) => {
      const entry = await deps.edoCapability.hypothesize({
        id: input.id,
        domain: input.domain,
        title: input.title,
        content: input.content,
        evaluateAt: new Date(input.evaluateAt),
        resolutionStrategy:
          input.resolutionStrategy === "manual" ||
          input.resolutionStrategy === undefined
            ? null
            : input.resolutionStrategy,
        evidenceForIds: input.evidenceForIds,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        sourceNode: input.sourceNode,
        tags: input.tags,
        confidencePct: input.confidencePct,
      });

      return {
        entry: {
          id: entry.id,
          domain: entry.domain,
          title: entry.title,
          confidencePct: entry.confidencePct,
          sourceType: entry.sourceType,
        },
        evaluateAt: input.evaluateAt,
        resolutionStrategy:
          input.resolutionStrategy === "manual" ||
          input.resolutionStrategy === undefined
            ? null
            : input.resolutionStrategy,
        evidenceCitationCount: input.evidenceForIds?.length ?? 0,
        committed: true,
        message: `Hypothesis '${entry.id}' filed; resolves at ${input.evaluateAt} (strategy: ${input.resolutionStrategy ?? "manual"})`,
      };
    },
  };
}

export const edoHypothesizeStubImplementation: ToolImplementation<
  EdoHypothesizeInput,
  EdoHypothesizeOutput
> = {
  execute: async () => {
    throw new Error(
      "EdoCapability not configured. Hypothesis-loop access not available."
    );
  },
};

// ─── Bound Tool ──────────────────────────────────────────────────────────────

export const edoHypothesizeBoundTool: BoundTool<
  typeof EDO_HYPOTHESIZE_NAME,
  EdoHypothesizeInput,
  EdoHypothesizeOutput,
  EdoHypothesizeRedacted
> = {
  contract: edoHypothesizeContract,
  implementation: edoHypothesizeStubImplementation,
};
