// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/types`
 * Purpose: Core type definitions for tool contracts and implementations.
 * Scope: Defines ToolContract, ToolImplementation, BoundTool. Does NOT import @langchain.
 * Invariants:
 *   - Pure types only, no runtime logic
 *   - EFFECT_TYPED: ToolContract includes `effect: ToolEffect` for policy decisions
 *   - NO LangChain imports (LangChain wrapping lives in langgraph-graphs)
 *   - Tools are pure functions with Zod validation
 *   - inputSchema is the source of truth; validateInput derives from it
 * Side-effects: none (types only)
 * Links: LANGGRAPH_AI.md, TOOL_USE_SPEC.md
 * @public
 */

import type { ToolEffect, ToolFailureReceipt } from "@cogni/ai-core";
import type { z } from "zod";

/**
 * Tool implementation result shape (pre-redaction).
 *
 * NOTE: Intentionally separate from `ToolExecResult` in @cogni/ai-core.
 * - `ToolResult<T>` (here): Raw result from tool implementation, before redaction
 * - `ToolExecResult<T>` (ai-core): Result after toolRunner pipeline (validated, redacted)
 *
 * The types are structurally identical but semantically distinct layers.
 * Do not unify — this separation enables future divergence if needed.
 */
export type ToolResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly errorCode: ToolErrorCode;
      readonly safeMessage: string;
      readonly retryable?: false;
      readonly receipt?: ToolFailureReceipt;
    };

/**
 * Tool error codes.
 * Per TOOLRUNNER_RESULT_SHAPE: standardized error classification.
 */
export type ToolErrorCode =
  | "validation"
  | "execution"
  | "unavailable"
  | "redaction_failed"
  | "policy_denied";

/**
 * Tool contract definition.
 * Defines schema and interface for a tool without implementation.
 *
 * inputSchema is the source of truth for tool input validation.
 * This enables:
 * - LangChain tool wrapping (needs Zod schema)
 * - Wire format compilation via toToolSpec() (compiles to JSONSchema7)
 * - Consistent validation across all execution paths
 */
export interface ToolContract<
  TName extends string,
  TInput,
  TOutput,
  TRedacted,
> {
  /** Stable tool name (snake_case, namespaced: core:tool_name) */
  readonly name: TName;
  /** Human-readable description for LLM */
  readonly description: string;
  /** Side-effect level for policy decisions */
  readonly effect: ToolEffect;
  /**
   * Zod schema for input validation.
   * Source of truth — used by LangChain wrappers and compiled to JSONSchema7.
   */
  readonly inputSchema: z.ZodType<TInput>;
  /**
   * Zod schema for output validation.
   */
  readonly outputSchema: z.ZodType<TOutput>;
  /** Redact output to UI-safe fields */
  readonly redact: (output: TOutput) => TRedacted;
  /** Allowlisted fields that appear in redacted output */
  readonly allowlist: ReadonlyArray<keyof TOutput>;
}

/**
 * Tool implementation interface.
 * Adapters implement this; receives validated input, returns raw output.
 */
export interface ToolImplementation<TInput, TOutput> {
  /** Execute the tool with validated input */
  readonly execute: (input: TInput) => Promise<TOutput>;
}

/**
 * Bound tool: contract + implementation together.
 * Created by package, consumed by tool-runner.
 */
export interface BoundTool<TName extends string, TInput, TOutput, TRedacted> {
  readonly contract: ToolContract<TName, TInput, TOutput, TRedacted>;
  readonly implementation: ToolImplementation<TInput, TOutput>;
}
