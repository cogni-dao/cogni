// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/api/creditsSummaryClient`
 * Purpose: Typed HTTP client for credits summary API endpoint with discriminated union returns.
 * Scope: Provides getSummary method to fetch billing account balance and ledger entries. Does not perform state management or domain logic.
 * Invariants: Always parses JSON body to surface server error codes; returns discriminated union for pattern matching.
 * Side-effects: IO (fetch API); never throws (returns ApiError for both HTTP errors and network failures).
 * Notes: All types derived from contracts via z.infer; hook layer handles React Query integration.
 * Links: docs/spec/payments-design.md
 * @public
 */

import type {
  CreditsSummaryInput,
  CreditsSummaryOutput,
} from "@cogni/node-contracts";
import { clientLogger, EVENT_NAMES } from "@cogni/node-shared";

/**
 * Resolves a relative URL path to an absolute URL.
 * In browser: uses window.location.origin
 * In Node (tests): falls back to http://localhost
 */
function resolveUrl(path: string): string {
  const base =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "http://localhost";
  return new URL(path, base).toString();
}

type ApiSuccess<T> = { ok: true; data: T };
type ApiError = { ok: false; error: string; errorCode?: string };
type ApiResult<T> = ApiSuccess<T> | ApiError;

/**
 * Handles fetch response, always parsing JSON body to surface server errors.
 * Returns discriminated union for pattern matching in caller.
 */
async function handleResponse<T>(res: Response): Promise<ApiResult<T>> {
  const body = await res.json().catch(() => ({ error: "Invalid response" }));

  if (!res.ok) {
    clientLogger.error(EVENT_NAMES.CLIENT_PAYMENTS_CREDITS_SUMMARY_HTTP_ERROR, {
      status: res.status,
      error: body.error ?? body.errorMessage ?? "Request failed",
      errorCode: body.errorCode,
    });
    return {
      ok: false,
      error: body.error ?? body.errorMessage ?? "Request failed",
      errorCode: body.errorCode,
    };
  }

  return { ok: true, data: body as T };
}

export const creditsSummaryClient = {
  /**
   * Fetches credits balance and recent ledger entries for the authenticated user.
   * @param input - Optional query parameters (limit: max ledger entries to return)
   * @returns Summary with billingAccountId, balanceCredits, and ledger array
   */
  getSummary: async (
    input?: CreditsSummaryInput
  ): Promise<ApiResult<CreditsSummaryOutput>> => {
    try {
      const params = new URLSearchParams();
      if (input?.limit !== undefined) {
        params.set("limit", String(input.limit));
      }

      const url = `/api/v1/payments/credits/summary${
        params.toString() ? `?${params}` : ""
      }`;

      const res = await fetch(resolveUrl(url));
      return handleResponse<CreditsSummaryOutput>(res);
    } catch (error) {
      clientLogger.error(
        EVENT_NAMES.CLIENT_PAYMENTS_CREDITS_SUMMARY_NETWORK_ERROR,
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Network error occurred",
      };
    }
  },
};
