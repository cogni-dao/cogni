// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/ai/execution-error-mapper`
 * Purpose: Map AiExecutionErrorCode to HTTP responses at the route edge.
 * Scope: Single canonical mapping from serialization-safe execution error codes to HTTP status/message.
 *   Used by both /api/v1/ai/chat and /v1/chat/completions route handlers.
 * Invariants:
 *   - AiExecutionError is the canonical cross-boundary error (Temporal+Redis → facade → route)
 *   - No fake port/feature error reconstruction — map codes directly to HTTP
 * Side-effects: none
 * Links: @cogni/ai-core/execution/error-codes, route handlers
 * @internal
 */

import type { AiExecutionErrorCode } from "@cogni/ai-core";

// Chat route uses 402 (Payment Required) for insufficient credits.
// OpenAI-compat route uses 429 (Too Many Requests) per OpenAI API convention.
// This is intentional — each route follows its own API contract.
const HTTP_STATUS_MAP: Record<AiExecutionErrorCode, number> = {
  insufficient_credits: 402,
  rate_limit: 429,
  timeout: 408,
  aborted: 408,
  not_found: 404,
  invalid_request: 400,
  internal: 500,
};

const OPENAI_ERROR_MAP: Record<
  AiExecutionErrorCode,
  { status: number; message: string; type: string }
> = {
  insufficient_credits: {
    status: 429,
    message:
      "You exceeded your current quota. Please check your plan and billing details.",
    type: "insufficient_quota",
  },
  rate_limit: {
    status: 429,
    message: "Rate limit exceeded. Please retry after a brief wait.",
    type: "rate_limit_error",
  },
  timeout: {
    status: 408,
    message: "Request timed out.",
    type: "timeout_error",
  },
  aborted: {
    status: 408,
    message: "Request was cancelled.",
    type: "timeout_error",
  },
  not_found: {
    status: 404,
    message: "The model does not exist or you do not have access to it.",
    type: "invalid_request_error",
  },
  invalid_request: {
    status: 400,
    message: "Invalid request.",
    type: "invalid_request_error",
  },
  internal: {
    status: 500,
    message: "The server encountered an internal error. Please retry.",
    type: "server_error",
  },
};

const OPENAI_FALLBACK = {
  status: 500,
  message: "The server encountered an internal error.",
  type: "server_error",
};

/**
 * Map execution error code to HTTP status for JSON error responses.
 * Used by /api/v1/ai/chat route.
 */
export function executionErrorToHttpStatus(code: AiExecutionErrorCode): number {
  return HTTP_STATUS_MAP[code] ?? 500;
}

/**
 * Map execution error code to OpenAI-compatible error response fields.
 * Used by /v1/chat/completions route (OpenAI API contract).
 */
export function executionErrorToOpenAiError(code: AiExecutionErrorCode): {
  status: number;
  message: string;
  type: string;
} {
  return OPENAI_ERROR_MAP[code] ?? OPENAI_FALLBACK;
}
