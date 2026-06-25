// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/errors`
 * Purpose: Feature-level error types and error translation for payment operations.
 * Scope: Defines discriminated union for payment errors; maps port errors to feature errors; does not throw errors directly.
 * Invariants: All errors include attempt ID or relevant identifiers for debugging.
 * Side-effects: none
 * Notes: Feature errors are translated to HTTP status codes at route layer.
 * Links: Used by payment service and routes
 * @public
 */

import {
  isPaymentAttemptNotFoundPortError,
  isPaymentRailMisconfiguredPortError,
  isTxHashAlreadyBoundPortError,
  type PaymentRailMisconfigurationCode,
} from "@/ports";

// ============================================================================
// Typed Error Classes (for facades/routes)
// ============================================================================

/**
 * Thrown when authenticated user not found in database
 * Maps to 401 at HTTP layer
 */
export class AuthUserNotFoundError extends Error {
  constructor(userId: string) {
    super(`User ${userId} not provisioned in database`);
    this.name = "AuthUserNotFoundError";
  }
}

/**
 * Thrown when wallet address is required but user authenticated via OAuth without a linked wallet.
 * Maps to 403 at HTTP layer.
 */
export class WalletRequiredError extends Error {
  constructor() {
    super("Wallet address required for payment operations");
    this.name = "WalletRequiredError";
  }
}

/**
 * Thrown when payment attempt not found or not owned by user
 * Maps to 404 at HTTP layer
 */
export class PaymentNotFoundError extends Error {
  constructor(
    public readonly attemptId: string,
    public readonly billingAccountId?: string
  ) {
    super(`Payment attempt ${attemptId} not found or not owned by user`);
    this.name = "PaymentNotFoundError";
  }
}

/**
 * Thrown when live payment rails cannot be proven ready for the configured repo-spec economics.
 * Maps to 503 at HTTP layer.
 */
export class PaymentRailNotReadyError extends Error {
  constructor(
    public readonly code: PaymentRailMisconfigurationCode,
    message = "Payment rails are not ready"
  ) {
    super(message);
    this.name = "PaymentRailNotReadyError";
  }
}

// ============================================================================
// Discriminated Union (for service layer)
// ============================================================================

/**
 * Discriminated union of payment feature errors
 * Used for type-safe error handling in feature layer
 */
export type PaymentsFeatureError =
  | {
      kind: "PAYMENT_NOT_FOUND";
      attemptId: string;
      billingAccountId?: string;
    }
  | { kind: "PAYMENT_EXPIRED"; attemptId: string; expiresAt: Date }
  | {
      kind: "TX_HASH_CONFLICT";
      txHash: string;
      existingAttemptId: string;
      chainId: number;
    }
  | { kind: "INVALID_AMOUNT"; min: number; max: number; actual: number }
  | { kind: "PAYMENT_RAIL_NOT_READY"; code: PaymentRailMisconfigurationCode }
  | { kind: "GENERIC"; message?: string };

/**
 * Type guard for PaymentsFeatureError
 * @param error - Error to check
 * @returns true if error is PaymentsFeatureError
 */
export function isPaymentsFeatureError(
  error: unknown
): error is PaymentsFeatureError {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    typeof error.kind === "string" &&
    [
      "PAYMENT_NOT_FOUND",
      "PAYMENT_EXPIRED",
      "TX_HASH_CONFLICT",
      "INVALID_AMOUNT",
      "PAYMENT_RAIL_NOT_READY",
      "GENERIC",
    ].includes(error.kind)
  );
}

/**
 * Maps port-level errors to feature-level errors
 * Translates infrastructure errors to domain errors
 *
 * @param error - Port error to map
 * @returns Feature error with kind and details
 */
export function mapPaymentPortErrorToFeature(
  error: unknown
): PaymentsFeatureError {
  // Port error: PaymentAttemptNotFoundPortError → PAYMENT_NOT_FOUND
  if (isPaymentAttemptNotFoundPortError(error)) {
    const result: PaymentsFeatureError = {
      kind: "PAYMENT_NOT_FOUND",
      attemptId: error.attemptId,
    };
    if (error.billingAccountId !== undefined) {
      result.billingAccountId = error.billingAccountId;
    }
    return result;
  }

  // Port error: TxHashAlreadyBoundPortError → TX_HASH_CONFLICT
  if (isTxHashAlreadyBoundPortError(error)) {
    return {
      kind: "TX_HASH_CONFLICT",
      txHash: error.txHash,
      existingAttemptId: error.existingAttemptId,
      chainId: error.chainId,
    };
  }

  // Port error: PaymentRailMisconfiguredPortError → PAYMENT_RAIL_NOT_READY
  if (isPaymentRailMisconfiguredPortError(error)) {
    return {
      kind: "PAYMENT_RAIL_NOT_READY",
      code: error.code,
    };
  }

  // Generic error fallback
  return {
    kind: "GENERIC",
    message: error instanceof Error ? error.message : "Unknown error",
  };
}
