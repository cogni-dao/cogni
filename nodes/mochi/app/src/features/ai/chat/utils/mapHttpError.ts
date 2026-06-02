// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/chat/utils/mapHttpError`
 * Purpose: Map HTTP response errors to structured ChatError for UI signaling.
 * Scope: Feature-internal utility. Does not implement retry logic or UI.
 * Invariants: Returns valid ChatError for any status code.
 * Side-effects: none
 * Notes: Keep internal to feature; do not export from public.ts
 * Links: ChatRuntimeProvider, error.chat.v1.contract
 * @internal
 */

import type { ChatError } from "@cogni/node-contracts";

/**
 * Map HTTP response to structured ChatError.
 *
 * @param status - HTTP status code
 * @param responseBody - Parsed JSON body (optional)
 * @param requestId - Client request ID for correlation (optional)
 */
export function mapHttpError(
  status: number,
  responseBody?: { error?: string; message?: string; code?: string },
  requestId?: string
): ChatError {
  const message =
    responseBody?.error ?? responseBody?.message ?? "Unknown error";

  switch (status) {
    case 401:
      return {
        code: "AUTH_EXPIRED",
        message: "Session expired. Please sign in again.",
        httpStatus: status,
        requestId,
        retryable: false,
        blocking: true,
        suggestedAction: "signin",
      };

    case 402:
      return {
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits to use this model.",
        httpStatus: status,
        requestId,
        retryable: false,
        blocking: true,
        suggestedAction: "add_credits",
      };

    case 403:
      return {
        code: "FORBIDDEN",
        message,
        httpStatus: status,
        requestId,
        retryable: false,
        blocking: true,
      };

    case 400:
      return {
        code: "BAD_REQUEST",
        message,
        httpStatus: status,
        requestId,
        retryable: false,
        blocking: true,
      };

    case 408:
      return {
        code: "TIMEOUT",
        message: "Request timed out. Please try again.",
        httpStatus: status,
        requestId,
        retryable: true,
        blocking: false,
        suggestedAction: "retry",
      };

    case 429:
      return {
        code: "RATE_LIMIT",
        message: "Too many requests. Please wait a moment.",
        httpStatus: status,
        requestId,
        retryable: true,
        blocking: false,
        suggestedAction: "retry",
      };

    case 503:
    case 502:
    case 504:
      return {
        code: "SERVICE_UNAVAILABLE",
        message: "AI service temporarily unavailable.",
        httpStatus: status,
        requestId,
        retryable: true,
        blocking: false,
        suggestedAction: "retry",
      };

    default:
      if (status >= 500) {
        return {
          code: "SERVER_ERROR",
          message: "Something went wrong. Please try again.",
          httpStatus: status,
          requestId,
          retryable: true,
          blocking: false,
          suggestedAction: "retry",
        };
      }
      return {
        code: "UNKNOWN",
        message,
        httpStatus: status,
        requestId,
        retryable: false,
        blocking: true,
      };
  }
}

/**
 * Map network/fetch exceptions to structured ChatError.
 * Use this for errors that don't have an HTTP status (connection failures, etc).
 *
 * @param requestId - Client request ID for correlation (optional)
 */
export function mapNetworkError(requestId?: string): ChatError {
  return {
    code: "NETWORK_ERROR",
    message: "Network error. Please check your connection.",
    requestId,
    retryable: true,
    blocking: false,
    suggestedAction: "retry",
  };
}
