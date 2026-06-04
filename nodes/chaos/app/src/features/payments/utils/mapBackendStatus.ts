// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/utils/mapBackendStatus`
 * Purpose: Maps backend payment statuses to UI phases and error messages.
 * Scope: Maps PaymentStatus to UiPhase + UiResult. Does not perform business logic.
 * Invariants: Status values match contract exactly; error codes map to messages.
 * Side-effects: none
 * Notes: Single place backend status strings are interpreted.
 * Links: docs/spec/payments-design.md
 * @public
 */

import type { PaymentErrorCode, PaymentStatus } from "@cogni/node-core";

export type UiPhase = "READY" | "PENDING" | "DONE";
export type UiResult = "SUCCESS" | "ERROR" | null;

export interface MappedStatus {
  phase: UiPhase;
  result: UiResult;
  errorMessage: string | null;
}

/**
 * Maps backend client-visible status to UI phase and result.
 * This is the ONLY place backend status strings should be interpreted.
 *
 * Status values: PENDING_VERIFICATION | CONFIRMED | FAILED
 *
 * @param status - Backend status from GET /api/v1/payments/attempts/:id
 * @param errorCode - Optional error code for FAILED status
 * @returns UI-friendly phase, result, and error message
 */
export function mapBackendStatus(
  status: PaymentStatus,
  errorCode?: PaymentErrorCode
): MappedStatus {
  switch (status) {
    case "PENDING_VERIFICATION":
      return { phase: "PENDING", result: null, errorMessage: null };
    case "CONFIRMED":
      return { phase: "DONE", result: "SUCCESS", errorMessage: null };
    case "FAILED":
      return {
        phase: "DONE",
        result: "ERROR",
        errorMessage: getErrorMessage(errorCode),
      };
    default:
      // Exhaustive check - catches new backend statuses at compile time
      return assertNever(status);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected status value: ${String(value)}`);
}

/**
 * Converts backend error codes to human-readable messages.
 * Matches error codes from PAYMENTS_DESIGN.md error enumeration.
 */
function getErrorMessage(errorCode?: PaymentErrorCode): string {
  const messages: Record<PaymentErrorCode, string> = {
    SENDER_MISMATCH: "Transaction sender does not match your wallet",
    INVALID_TOKEN: "Wrong token used for payment",
    INVALID_RECIPIENT: "Payment sent to wrong address",
    INVALID_CHAIN: "Payment sent on wrong blockchain network",
    INSUFFICIENT_AMOUNT: "Payment amount too low",
    INSUFFICIENT_CONFIRMATIONS: "Transaction needs more confirmations",
    TX_NOT_FOUND: "Transaction not found on-chain",
    TX_REVERTED: "Transaction reverted on-chain",
    TOKEN_TRANSFER_NOT_FOUND: "No token transfer found in transaction",
    RECIPIENT_MISMATCH: "Payment sent to wrong recipient",
    RECEIPT_NOT_FOUND: "Transaction not found after 24 hours",
    INTENT_EXPIRED: "Payment intent expired",
    RPC_ERROR: "Unable to verify transaction on-chain",
  };
  return errorCode ? messages[errorCode] : "Payment failed";
}
