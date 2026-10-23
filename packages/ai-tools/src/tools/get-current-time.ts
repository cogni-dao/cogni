// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/get-current-time`
 * Purpose: Simple tool that returns the current UTC time.
 * Scope: First tool for testing agentic loop. Does not have IO dependencies (pure).
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__get_current_time` (double-underscore for provider compat)
 *   - EFFECT_TYPED: effect is `read_only` (pure computation)
 *   - Pure function, no side effects beyond Date.now()
 *   - Returns ISO 8601 format timestamp
 *   - No sensitive data (full output in allowlist)
 *   - NO LangChain imports (LangChain wrapping in langgraph-graphs)
 * Side-effects: none
 * Notes: Per TOOL_USE_SPEC.md P0 first tool requirement
 * Links: TOOL_USE_SPEC.md, LANGGRAPH_AI.md
 * @public
 */

import { z } from "zod";

import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input schema: empty object (tool takes no parameters)
 */
export const GetCurrentTimeInputSchema = z.object({}).strict();
export type GetCurrentTimeInput = z.infer<typeof GetCurrentTimeInputSchema>;

/**
 * Output schema: ISO 8601 timestamp
 */
export const GetCurrentTimeOutputSchema = z.object({
  currentTime: z.string().describe("Current UTC time in ISO 8601 format"),
});
export type GetCurrentTimeOutput = z.infer<typeof GetCurrentTimeOutputSchema>;

/**
 * Redacted output (same as output - no sensitive data)
 */
export type GetCurrentTimeRedacted = GetCurrentTimeOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Namespaced tool ID per TOOL_ID_NAMESPACED invariant.
 * Uses double-underscore separator (provider-compatible: OpenAI allows [a-zA-Z0-9_-]+)
 */
export const GET_CURRENT_TIME_NAME = "core__get_current_time" as const;

export const getCurrentTimeContract: ToolContract<
  typeof GET_CURRENT_TIME_NAME,
  GetCurrentTimeInput,
  GetCurrentTimeOutput,
  GetCurrentTimeRedacted
> = {
  name: GET_CURRENT_TIME_NAME,
  description: "Get the current UTC time. Returns the time in ISO 8601 format.",
  effect: "read_only",
  requires: "node.collaborate",
  inputSchema: GetCurrentTimeInputSchema,
  outputSchema: GetCurrentTimeOutputSchema,

  redact: (output: GetCurrentTimeOutput): GetCurrentTimeRedacted => {
    // No sensitive data - return full output
    return { currentTime: output.currentTime };
  },

  allowlist: ["currentTime"] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export const getCurrentTimeImplementation: ToolImplementation<
  GetCurrentTimeInput,
  GetCurrentTimeOutput
> = {
  execute: async (
    _input: GetCurrentTimeInput
  ): Promise<GetCurrentTimeOutput> => {
    return {
      currentTime: new Date().toISOString(),
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Bound Tool (contract + implementation)
// ─────────────────────────────────────────────────────────────────────────────

export const getCurrentTimeBoundTool: BoundTool<
  typeof GET_CURRENT_TIME_NAME,
  GetCurrentTimeInput,
  GetCurrentTimeOutput,
  GetCurrentTimeRedacted
> = {
  contract: getCurrentTimeContract,
  implementation: getCurrentTimeImplementation,
};
