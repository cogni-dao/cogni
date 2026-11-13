// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-core/execution/error-codes`
 * Purpose: Canonical error codes, error class, and normalization for AI execution failures.
 * Scope: Single source of truth for execution error codes and normalization logic. Does NOT define business logic.
 * Invariants:
 *   - SINGLE_SOURCE_OF_TRUTH: All error codes defined here, imported everywhere else
 *   - ERROR_NORMALIZATION_ONCE: normalizeErrorToExecutionCode() is the canonical normalizer
 *   - AiExecutionError carries structured code through call chains
 *   - Recognizes both AiExecutionError (.code) and LlmError (.kind, .status)
 * Side-effects: none
 * Links: GRAPH_EXECUTION.md, ERROR_HANDLING_ARCHITECTURE.md, llm-errors.ts
 * @public
 */

import { isLlmError } from "./llm-errors";

/**
 * Canonical error codes for AI execution failures.
 * - invalid_request: Required input missing or malformed (client error)
 * - not_found: Requested resource (e.g., graph) does not exist (client error)
 * - timeout: Request exceeded time limit
 * - aborted: Request was cancelled (e.g., AbortSignal)
 * - rate_limit: Provider rate limit exceeded (HTTP 429)
 * - internal: Unexpected error during execution (server fault — our bug)
 * - insufficient_credits: The USER's billing account lacks sufficient credits (user-fixable)
 * - provider_unavailable: Upstream LLM provider is down (5xx / outage). Operator-fault —
 *   the user cannot fix it. MUST stay distinct from insufficient_credits so the UI never
 *   tells the user to top up their balance for an operator billing problem (bug.5056).
 * - provider_unfunded: The OPERATOR's provider account is out of credit (OpenRouter 402).
 *   Operator-fault and money-fixable, so it is its own code: a starved run is not a
 *   verdict and not an outage (bug.5626, starvation-not-a-verdict).
 */
export const AI_EXECUTION_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "timeout",
  "aborted",
  "rate_limit",
  "internal",
  "insufficient_credits",
  "provider_unavailable",
  "provider_unfunded",
] as const;

export type AiExecutionErrorCode = (typeof AI_EXECUTION_ERROR_CODES)[number];

/**
 * Type guard for AiExecutionErrorCode.
 * Validates that a value is a known error code at runtime.
 */
export function isAiExecutionErrorCode(x: unknown): x is AiExecutionErrorCode {
  return (
    typeof x === "string" &&
    AI_EXECUTION_ERROR_CODES.includes(x as AiExecutionErrorCode)
  );
}

/**
 * Error class that carries a structured AiExecutionErrorCode.
 * Used by CogniCompletionAdapter and other layers to propagate error codes
 * without losing type information through the call chain.
 */
export class AiExecutionError extends Error {
  readonly code: AiExecutionErrorCode;

  constructor(code: AiExecutionErrorCode, message?: string) {
    super(message ?? `AI execution failed: ${code}`);
    this.name = "AiExecutionError";
    this.code = code;
  }
}

/**
 * Type guard for AiExecutionError.
 */
export function isAiExecutionError(error: unknown): error is AiExecutionError {
  return error instanceof AiExecutionError;
}

/**
 * Normalize any error to stable AiExecutionErrorCode.
 *
 * Priority:
 * 1. AbortError → "aborted"
 * 2. AiExecutionError (.code field) → use code
 * 3. LlmError (.status, .kind) → map to code
 * 4. Default → "internal"
 *
 * FAULT_PARTY_BEFORE_BUCKET: upstream provider failures the operator must fix map to a
 * provider code, NOT "internal": a 402 (unfunded provider account) is "provider_unfunded",
 * a 5xx provider outage is "provider_unavailable". Collapsing them to "internal" is what
 * masked bug.5056 as a generic "Something went wrong" 500. See docs/spec/error-handling.md.
 */
export function normalizeErrorToExecutionCode(
  error: unknown
): AiExecutionErrorCode {
  // AbortError takes precedence
  if (error instanceof Error && error.name === "AbortError") {
    return "aborted";
  }

  // AiExecutionError with structured code
  if (error instanceof Error) {
    const errorWithCode = error as { code?: unknown };
    if (isAiExecutionErrorCode(errorWithCode.code)) {
      return errorWithCode.code;
    }
  }

  // LlmError with status/kind classification
  if (isLlmError(error)) {
    // Status-first (most reliable - HTTP status code)
    if (error.status === 429) return "rate_limit";
    if (error.status === 408) return "timeout";
    // Upstream provider billing — operator-fault, money-fixable, NOT "internal" (bug.5056)
    // and NOT an outage: a distinct code lets a starved run say so (bug.5626).
    if (error.status === 402) return "provider_unfunded";
    // Upstream provider availability — operator-fault, NOT "internal" (bug.5056).
    if (typeof error.status === "number" && error.status >= 500) {
      return "provider_unavailable";
    }

    // Kind fallback
    switch (error.kind) {
      case "rate_limited":
        return "rate_limit";
      case "timeout":
        return "timeout";
      case "aborted":
        return "aborted";
      case "provider_5xx":
        return "provider_unavailable";
      default:
        return "internal";
    }
  }

  // Unknown error type
  return "internal";
}
