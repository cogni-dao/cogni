// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/utils/mapBackendStatus`
 * Purpose: Maps backend payment statuses to UI phases + structured errors.
 * Scope: Maps PaymentStatus to UiPhase + UiResult. Does not perform business logic.
 * Invariants: Status values match contract exactly; error codes map via formatPaymentError (one SSOT).
 * Side-effects: none
 * Notes: Single place backend status strings are interpreted.
 * Links: docs/spec/payments-design.md
 * @public
 */

import type {
  PaymentErrorCode,
  PaymentStatus,
  PaymentUiError,
} from "@cogni/node-core";
import { formatPaymentError } from "./formatPaymentError";

export type UiPhase = "READY" | "PENDING" | "DONE";
export type UiResult = "SUCCESS" | "ERROR" | null;

export interface MappedStatus {
  phase: UiPhase;
  result: UiResult;
  error: PaymentUiError | null;
}

/**
 * Maps backend client-visible status to UI phase and result.
 * This is the ONLY place backend status strings should be interpreted.
 *
 * Status values: PENDING_VERIFICATION | CONFIRMED | FAILED
 *
 * @param status - Backend status from GET /api/v1/payments/attempts/:id
 * @param errorCode - Optional error code for FAILED status
 * @returns UI-friendly phase, result, and structured error
 */
export function mapBackendStatus(
  status: PaymentStatus,
  errorCode?: PaymentErrorCode
): MappedStatus {
  switch (status) {
    case "PENDING_VERIFICATION":
      return { phase: "PENDING", result: null, error: null };
    case "CONFIRMED":
      return { phase: "DONE", result: "SUCCESS", error: null };
    case "FAILED":
      return { phase: "DONE", result: "ERROR", error: toUiError(errorCode) };
    default:
      // Exhaustive check - catches new backend statuses at compile time
      return assertNever(status);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected status value: ${String(value)}`);
}

/**
 * Convert a backend error code into a structured user-facing error.
 * Delegates to formatPaymentError (SSOT for code→presentation), dropping `debug`.
 */
function toUiError(errorCode?: PaymentErrorCode): PaymentUiError {
  const { debug: _debug, ...ui } = formatPaymentError(
    errorCode ? { code: errorCode } : undefined
  );
  return ui;
}
