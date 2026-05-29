// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/edo-decide`
 * Purpose: AI tool contract for filing a decision row that derives_from a hypothesis atomically.
 * Scope: Tool contract + stub + bound tool definition. Does not contain implementations of the underlying ports.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__edo_decide`
 *   - EFFECT_TYPED: effect is `state_change`
 *   - DECISION_CITES_HYPOTHESIS: derivesFromHypothesisId is required.
 *   - EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE: cited row must be a hypothesis.
 *   - EDO_TOOLS_ATOMIC: write + edge + commit happen in one call.
 * Side-effects: IO (database write + dolt_commit)
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import { z } from "zod";

import type { EdoCapability } from "../capabilities/edo";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const EdoDecideInputSchema = z.object({
  id: z.string().min(1).max(200).describe("Unique ID for this decision"),
  domain: z.string().min(1).describe("Registered knowledge domain"),
  title: z.string().min(1).max(500).describe("One-line summary of the action"),
  content: z
    .string()
    .min(1)
    .describe(
      "Full decision — what we did (or chose not to do) and why, anchored to the hypothesis"
    ),
  derivesFromHypothesisId: z
    .string()
    .min(1)
    .describe(
      "ID of the hypothesis this decision acts on. MUST refer to entry_type='hypothesis' — the adapter rejects otherwise."
    ),
  sourceType: z
    .enum(["human", "agent", "analysis_signal", "external", "derived"])
    .describe("Where this decision came from"),
  sourceRef: z.string().optional(),
  sourceNode: z.string().optional(),
  tags: z.array(z.string()).optional(),
  confidencePct: z.number().int().min(0).max(100).optional(),
});
export type EdoDecideInput = z.infer<typeof EdoDecideInputSchema>;

export const EdoDecideOutputSchema = z.object({
  entry: z.object({
    id: z.string(),
    domain: z.string(),
    title: z.string(),
    confidencePct: z.number().nullable(),
    sourceType: z.string(),
  }),
  derivesFromHypothesisId: z.string(),
  committed: z.boolean(),
  message: z.string(),
});
export type EdoDecideOutput = z.infer<typeof EdoDecideOutputSchema>;
export type EdoDecideRedacted = EdoDecideOutput;

// ─── Contract ────────────────────────────────────────────────────────────────

export const EDO_DECIDE_NAME = "core__edo_decide" as const;

export const edoDecideContract: ToolContract<
  typeof EDO_DECIDE_NAME,
  EdoDecideInput,
  EdoDecideOutput,
  EdoDecideRedacted
> = {
  name: EDO_DECIDE_NAME,
  description:
    "File a decision (the action taken on a hypothesis) + derives_from citation + auto-commit. " +
    "Decisions without a falsifiable prediction should be filed as 'finding' via core__knowledge_write instead. " +
    "The derivesFromHypothesisId MUST refer to a hypothesis row — the adapter rejects mismatched entry_types.",
  effect: "state_change",
  inputSchema: EdoDecideInputSchema,
  outputSchema: EdoDecideOutputSchema,
  redact: (output) => output,
  allowlist: [
    "entry",
    "derivesFromHypothesisId",
    "committed",
    "message",
  ] as const,
};

// ─── Implementation ──────────────────────────────────────────────────────────

export interface EdoDecideDeps {
  edoCapability: EdoCapability;
}

export function createEdoDecideImplementation(
  deps: EdoDecideDeps
): ToolImplementation<EdoDecideInput, EdoDecideOutput> {
  return {
    execute: async (input) => {
      const entry = await deps.edoCapability.decide({
        id: input.id,
        domain: input.domain,
        title: input.title,
        content: input.content,
        derivesFromHypothesisId: input.derivesFromHypothesisId,
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
        derivesFromHypothesisId: input.derivesFromHypothesisId,
        committed: true,
        message: `Decision '${entry.id}' filed; derives from '${input.derivesFromHypothesisId}'`,
      };
    },
  };
}

export const edoDecideStubImplementation: ToolImplementation<
  EdoDecideInput,
  EdoDecideOutput
> = {
  execute: async () => {
    throw new Error(
      "EdoCapability not configured. Hypothesis-loop access not available."
    );
  },
};

// ─── Bound Tool ──────────────────────────────────────────────────────────────

export const edoDecideBoundTool: BoundTool<
  typeof EDO_DECIDE_NAME,
  EdoDecideInput,
  EdoDecideOutput,
  EdoDecideRedacted
> = {
  contract: edoDecideContract,
  implementation: edoDecideStubImplementation,
};
