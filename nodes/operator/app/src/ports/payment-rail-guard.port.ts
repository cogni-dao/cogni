// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/payment-rail-guard`
 * Purpose: Fail-closed guard for live payment rail activation before an intent is issued.
 * Scope: Defines the port and typed misconfiguration error. Implementations may read chain state.
 * Side-effects: none
 * Links: docs/spec/payments-design.md
 * @public
 */

export type PaymentRailMisconfigurationCode =
  | "PAYMENT_RAIL_UNCONFIGURED"
  | "INVALID_CHAIN"
  | "SPLIT_CONTRACT_MISSING"
  | "SPLIT_CONFIG_MISMATCH"
  | "PAYMENT_RAIL_CHECK_FAILED";

export interface PaymentRailGuardConfig {
  chainId: number;
  receivingAddress: string;
  markupFactor: number;
  revenueShare: number;
}

export class PaymentRailMisconfiguredPortError extends Error {
  constructor(
    public readonly code: PaymentRailMisconfigurationCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "PaymentRailMisconfiguredPortError";
  }
}

export function isPaymentRailMisconfiguredPortError(
  error: unknown
): error is PaymentRailMisconfiguredPortError {
  return (
    error instanceof PaymentRailMisconfiguredPortError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "PaymentRailMisconfiguredPortError" &&
      "code" in error)
  );
}

export interface PaymentRailGuardPort {
  /**
   * Assert the receiving Split is deployed and matches the configured economics.
   * Implementations must fail closed on unreadable or mismatched chain state.
   */
  assertReady(config: PaymentRailGuardConfig): Promise<void>;
}
