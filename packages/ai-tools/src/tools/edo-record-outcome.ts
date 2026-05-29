// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/edo-record-outcome`
 * Purpose: AI tool contract for filing an outcome row plus a validates/invalidates citation that closes the hypothesis loop.
 * Scope: Tool contract + stub + bound tool definition. Does not contain implementations of the underlying ports.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__edo_record_outcome`
 *   - EFFECT_TYPED: effect is `state_change`
 *   - OUTCOME_CITES_HYPOTHESIS: hypothesisId is required.
 *   - CONFIDENCE_RECOMPUTE_ON_RESOLVE: triggers 1-hop pure recompute.
 *   - RESOLVER_IDEMPOTENT: double-firing returns existing state, no double-write.
 * Side-effects: IO (database write + dolt_commit)
 * Links: docs/spec/knowledge-syntropy.md
 * @public
 */

import { z } from "zod";

import type { EdoCapability } from "../capabilities/edo";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const EdoRecordOutcomeInputSchema = z.object({
  id: z.string().min(1).max(200).describe("Unique ID for the outcome row"),
  domain: z.string().min(1).describe("Registered knowledge domain"),
  title: z
    .string()
    .min(1)
    .max(500)
    .describe("One-line summary of what happened"),
  content: z
    .string()
    .min(1)
    .describe("Full outcome — the observed result, the delta vs prediction"),
  hypothesisId: z
    .string()
    .min(1)
    .describe(
      "ID of the hypothesis being resolved. MUST refer to entry_type='hypothesis'."
    ),
  edge: z
    .enum(["validates", "invalidates"])
    .describe("Did the prediction hold?"),
  sourceType: z
    .enum(["human", "agent", "analysis_signal", "external", "derived"])
    .describe("Where this outcome came from"),
  sourceRef: z.string().optional(),
  sourceNode: z.string().optional(),
  tags: z.array(z.string()).optional(),
  confidencePct: z.number().int().min(0).max(100).optional(),
});
export type EdoRecordOutcomeInput = z.infer<typeof EdoRecordOutcomeInputSchema>;

export const EdoRecordOutcomeOutputSchema = z.object({
  outcome: z.object({
    id: z.string(),
    domain: z.string(),
    title: z.string(),
    confidencePct: z.number().nullable(),
    sourceType: z.string(),
  }),
  hypothesisId: z.string(),
  edge: z.string(),
  resolvedConfidence: z.number(),
  alreadyResolved: z.boolean(),
  committed: z.boolean(),
  message: z.string(),
});
export type EdoRecordOutcomeOutput = z.infer<
  typeof EdoRecordOutcomeOutputSchema
>;
export type EdoRecordOutcomeRedacted = EdoRecordOutcomeOutput;

// ─── Contract ────────────────────────────────────────────────────────────────

export const EDO_RECORD_OUTCOME_NAME = "core__edo_record_outcome" as const;

export const edoRecordOutcomeContract: ToolContract<
  typeof EDO_RECORD_OUTCOME_NAME,
  EdoRecordOutcomeInput,
  EdoRecordOutcomeOutput,
  EdoRecordOutcomeRedacted
> = {
  name: EDO_RECORD_OUTCOME_NAME,
  description:
    "File an outcome row + validates/invalidates citation + recompute confidence + auto-commit. " +
    "This closes the hypothesis loop: the prediction either held (validates) or failed (invalidates), " +
    "and confidence on the hypothesis updates mechanically via a 1-hop citation walk. " +
    "Idempotent on already-resolved hypotheses.",
  effect: "state_change",
  inputSchema: EdoRecordOutcomeInputSchema,
  outputSchema: EdoRecordOutcomeOutputSchema,
  redact: (output) => output,
  allowlist: [
    "outcome",
    "hypothesisId",
    "edge",
    "resolvedConfidence",
    "alreadyResolved",
    "committed",
    "message",
  ] as const,
};

// ─── Implementation ──────────────────────────────────────────────────────────

export interface EdoRecordOutcomeDeps {
  edoCapability: EdoCapability;
}

export function createEdoRecordOutcomeImplementation(
  deps: EdoRecordOutcomeDeps
): ToolImplementation<EdoRecordOutcomeInput, EdoRecordOutcomeOutput> {
  return {
    execute: async (input) => {
      const result = await deps.edoCapability.recordOutcome({
        id: input.id,
        domain: input.domain,
        title: input.title,
        content: input.content,
        hypothesisId: input.hypothesisId,
        edge: input.edge,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        sourceNode: input.sourceNode,
        tags: input.tags,
        confidencePct: input.confidencePct,
      });

      return {
        outcome: {
          id: result.outcome.id,
          domain: result.outcome.domain,
          title: result.outcome.title,
          confidencePct: result.outcome.confidencePct,
          sourceType: result.outcome.sourceType,
        },
        hypothesisId: result.hypothesisId,
        edge: input.edge,
        resolvedConfidence: result.resolvedConfidence,
        alreadyResolved: result.alreadyResolved,
        committed: true,
        message: result.alreadyResolved
          ? `Hypothesis '${result.hypothesisId}' was already resolved (conf: ${result.resolvedConfidence}%); no-op`
          : `Outcome '${result.outcome.id}' filed; hypothesis '${result.hypothesisId}' ${input.edge} (conf: ${result.resolvedConfidence}%)`,
      };
    },
  };
}

export const edoRecordOutcomeStubImplementation: ToolImplementation<
  EdoRecordOutcomeInput,
  EdoRecordOutcomeOutput
> = {
  execute: async () => {
    throw new Error(
      "EdoCapability not configured. Hypothesis-loop access not available."
    );
  },
};

// ─── Bound Tool ──────────────────────────────────────────────────────────────

export const edoRecordOutcomeBoundTool: BoundTool<
  typeof EDO_RECORD_OUTCOME_NAME,
  EdoRecordOutcomeInput,
  EdoRecordOutcomeOutput,
  EdoRecordOutcomeRedacted
> = {
  contract: edoRecordOutcomeContract,
  implementation: edoRecordOutcomeStubImplementation,
};
