// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/api/paymentsClient`
 * Purpose: Typed HTTP client for payment API endpoints with discriminated union returns.
 * Scope: Provides createIntent, submitTxHash, and getStatus methods. Does not perform state management or domain logic.
 * Invariants: Always parses JSON body to surface server error codes; returns discriminated union for pattern matching.
 * Side-effects: IO (fetch API); never throws on HTTP errors (returns ApiError instead).
 * Notes: All types derived from contracts via z.infer; hook layer handles business logic.
 * Links: docs/spec/payments-design.md
 * @public
 */

import type {
  PaymentIntentInput,
  PaymentIntentOutput,
  PaymentStatusOutput,
  PaymentSubmitInput,
  PaymentSubmitOutput,
} from "@cogni/node-contracts";
import { clientLogger, EVENT_NAMES } from "@cogni/node-shared";

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
    clientLogger.error(EVENT_NAMES.CLIENT_PAYMENTS_HTTP_ERROR, {
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

export const paymentsClient = {
  /**
   * Creates payment intent, returning on-chain transfer parameters.
   * @param input - Amount in USD cents (100-1,000,000)
   * @returns Intent with attemptId, chainId, token, to, amountRaw, expiresAt
   */
  createIntent: async (
    input: PaymentIntentInput
  ): Promise<ApiResult<PaymentIntentOutput>> => {
    const res = await fetch("/api/v1/payments/intents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return handleResponse<PaymentIntentOutput>(res);
  },

  /**
   * Submits transaction hash for verification.
   * @param attemptId - Payment attempt UUID from createIntent
   * @param input - Transaction hash (0x + 64 hex chars)
   * @returns Status with attemptId, status, txHash, optional errorCode/errorMessage
   */
  submitTxHash: async (
    attemptId: string,
    input: PaymentSubmitInput
  ): Promise<ApiResult<PaymentSubmitOutput>> => {
    const res = await fetch(`/api/v1/payments/attempts/${attemptId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return handleResponse<PaymentSubmitOutput>(res);
  },

  /**
   * Polls payment attempt status with throttled verification.
   * @param attemptId - Payment attempt UUID
   * @returns Current status (PENDING_VERIFICATION | CONFIRMED | FAILED), txHash, amountUsdCents, optional errorCode
   */
  getStatus: async (
    attemptId: string
  ): Promise<ApiResult<PaymentStatusOutput>> => {
    const res = await fetch(`/api/v1/payments/attempts/${attemptId}`);
    return handleResponse<PaymentStatusOutput>(res);
  },
};
