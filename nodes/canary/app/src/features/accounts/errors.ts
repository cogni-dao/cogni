// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/accounts/errors`
 * Purpose: Translate account port errors into feature-level error shapes.
 * Scope: Provides AccountsFeatureError types and guards; does not call ports or adapters.
 * Invariants: Pure functions, no side effects, no I/O.
 * Side-effects: none
 * Notes: Consumed by app facades to surface stable error kinds.
 * Links: src/features/accounts/public.ts
 * @public
 */
import {
  BillingAccountNotFoundPortError,
  InsufficientCreditsPortError,
  VirtualKeyNotFoundPortError,
} from "@/ports";

export type AccountsFeatureError =
  | {
      kind: "BILLING_ACCOUNT_NOT_FOUND";
      billingAccountId: string;
    }
  | {
      kind: "INSUFFICIENT_CREDITS";
      billingAccountId: string;
      required: number;
      available: number;
    }
  | {
      kind: "VIRTUAL_KEY_NOT_FOUND";
      billingAccountId: string;
      virtualKeyId?: string;
    }
  | { kind: "GENERIC"; message?: string };

export function isAccountsFeatureError(
  error: unknown
): error is AccountsFeatureError {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    typeof (error as AccountsFeatureError).kind === "string"
  );
}

export function mapAccountsPortErrorToFeature(
  error: unknown
): AccountsFeatureError {
  if (error instanceof BillingAccountNotFoundPortError) {
    return {
      kind: "BILLING_ACCOUNT_NOT_FOUND",
      billingAccountId: error.billingAccountId,
    };
  }

  if (error instanceof VirtualKeyNotFoundPortError) {
    return {
      kind: "VIRTUAL_KEY_NOT_FOUND",
      billingAccountId: error.billingAccountId,
      ...(error.virtualKeyId ? { virtualKeyId: error.virtualKeyId } : {}),
    };
  }

  if (error instanceof InsufficientCreditsPortError) {
    return {
      kind: "INSUFFICIENT_CREDITS",
      billingAccountId: error.billingAccountId,
      required: error.cost,
      available: error.previousBalance,
    };
  }

  if (isAccountsFeatureError(error)) {
    return error;
  }

  return {
    kind: "GENERIC",
    message: error instanceof Error ? error.message : "Unknown account error",
  };
}
