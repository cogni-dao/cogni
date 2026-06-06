// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/utils/formatPaymentError`
 * Purpose: Maps technical errors to user-friendly messages.
 * Scope: Pure error mapping utility. Does not handle UI rendering or logging.
 * Invariants: Never returns raw technical errors; always provides userMessage; debug field for logging only.
 * Side-effects: none
 * Notes: Prioritizes error codes → viem/wagmi types → string matching (fallback).
 * Links: docs/spec/payments-design.md
 * @public
 */

import type { PaymentErrorCode } from "@cogni/node-core";

export interface FormattedError {
  code: string;
  userMessage: string;
  debug?: string; // Original error for logging only - NEVER render in UI
}

/**
 * Map technical payment errors to user-friendly messages.
 * Priority: error codes (stable) → viem/wagmi types → string matching (fallback).
 */
export function formatPaymentError(error: unknown): FormattedError {
  // Handle null/undefined
  if (!error) {
    return {
      code: "UNKNOWN",
      userMessage: "Something went wrong - please try again",
    };
  }

  // Capture debug info
  const debug = error instanceof Error ? error.message : JSON.stringify(error);

  // 1. Check for our backend error codes (most stable)
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    const errorCode = error.code as PaymentErrorCode;

    switch (errorCode) {
      case "SENDER_MISMATCH":
        return {
          code: errorCode,
          userMessage: "Wallet address doesn't match",
          debug,
        };
      case "INVALID_TOKEN":
        return {
          code: errorCode,
          userMessage: "Invalid token contract",
          debug,
        };
      case "INSUFFICIENT_AMOUNT":
        return {
          code: errorCode,
          userMessage: "Payment amount too low",
          debug,
        };
      case "TX_REVERTED":
        return {
          code: errorCode,
          userMessage: "Transaction failed on-chain",
          debug,
        };
      case "INTENT_EXPIRED":
        return {
          code: errorCode,
          userMessage: "Payment session expired",
          debug,
        };
      case "RPC_ERROR":
        return {
          code: errorCode,
          userMessage: "Network error - please try again",
          debug,
        };
      case "INSUFFICIENT_CONFIRMATIONS":
        return {
          code: errorCode,
          userMessage: "Transaction not confirmed yet",
          debug,
        };
      case "RECEIPT_NOT_FOUND":
        return {
          code: errorCode,
          userMessage: "Transaction not found",
          debug,
        };
    }
  }

  // 2. Check for viem/wagmi error types (when code unavailable)
  if (error instanceof Error) {
    const errorName = error.constructor.name;

    if (
      errorName === "UserRejectedRequestError" ||
      errorName.includes("UserRejected")
    ) {
      return {
        code: "USER_REJECTED",
        userMessage: "Payment cancelled",
        debug,
      };
    }

    if (
      errorName === "InsufficientFundsError" ||
      errorName.includes("InsufficientFunds")
    ) {
      return {
        code: "INSUFFICIENT_FUNDS",
        userMessage: "Insufficient wallet balance",
        debug,
      };
    }

    if (
      errorName === "ContractFunctionRevertedError" ||
      errorName.includes("Reverted")
    ) {
      return {
        code: "CONTRACT_REVERTED",
        userMessage: "Transaction failed",
        debug,
      };
    }

    if (
      errorName === "TransactionReceiptNotFoundError" ||
      errorName.includes("ReceiptNotFound")
    ) {
      return {
        code: "RECEIPT_NOT_FOUND",
        userMessage: "Transaction not found",
        debug,
      };
    }

    // 3. String matching (fallback only)
    const message = error.message.toLowerCase();

    if (/user (rejected|denied)/.test(message)) {
      return {
        code: "USER_REJECTED",
        userMessage: "Payment cancelled",
        debug,
      };
    }

    if (/insufficient/.test(message)) {
      return {
        code: "INSUFFICIENT_BALANCE",
        userMessage: "Insufficient balance",
        debug,
      };
    }

    if (/network|timeout|fetch/.test(message)) {
      return {
        code: "NETWORK_ERROR",
        userMessage: "Network error - please try again",
        debug,
      };
    }
  }

  // Default fallback
  return {
    code: "UNKNOWN",
    userMessage: "Something went wrong - please try again",
    debug,
  };
}
