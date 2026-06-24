// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@types/payments`
 * Purpose: Payment flow types shared across all layers (bottom of dependency hierarchy).
 * Scope: Type-only exports; defines UI state, backend status enums, and error codes. Does not contain runtime code or functions.
 * Invariants: All exports are types, interfaces, or domain constants (amount bounds).
 * Side-effects: none
 * Notes: Single source of truth for payment types; prevents circular dependencies.
 * Links: docs/spec/payments-design.md
 * @public
 */

// ============================================================================
// UI State (Hook → Component Interface)
// ============================================================================

/**
 * Payment flow UI phase.
 * Maps backend statuses to simplified UI states for component rendering.
 */
export type PaymentFlowPhase = "READY" | "PENDING" | "DONE";

/**
 * Structured, user-facing payment error.
 *
 * Errors are propagated as structure, never a flattened "something went wrong"
 * string: the UI needs to know *what* happened, *who can fix it*, and *whether
 * retrying helps*. Every failure that reaches the user is shaped into this.
 */
export interface PaymentUiError {
  /** Stable code for analytics + presentation (e.g. INSUFFICIENT_BALANCE). */
  code: string;
  /** Short headline — what happened, in the user's terms (e.g. "Not enough USDC"). */
  title: string;
  /** One calm sentence explaining the situation. */
  message: string;
  /** Optional concrete next step the user can take (e.g. add funds on Base). */
  hint?: string;
  /** Whether retrying the same action can plausibly succeed (drives "Try again"). */
  recoverable: boolean;
}

/**
 * Complete payment flow state for UI rendering.
 * Consumed by UsdcPaymentFlow component, exported by usePaymentFlow hook.
 */
export interface PaymentFlowState {
  phase: PaymentFlowPhase;

  // READY phase
  isCreatingIntent: boolean;

  // PENDING phase
  walletStep: "SIGNING" | "CONFIRMING" | "SUBMITTING" | "VERIFYING" | null;
  txHash: string | null;
  explorerUrl: string | null;
  isInFlight: boolean; // True only during PENDING phases (not TERMINAL)

  // DONE phase
  result: "SUCCESS" | "ERROR" | null;
  error: PaymentUiError | null;
  creditsAdded: number | null;
}

// ============================================================================
// Backend Status Enums (Contract Types)
// ============================================================================

/**
 * Client-visible backend status from GET /api/v1/payments/attempts/:id.
 * Matches payments.status.v1.contract.ts output exactly.
 */
export type PaymentStatus = "PENDING_VERIFICATION" | "CONFIRMED" | "FAILED";

/**
 * Internal backend status from POST /api/v1/payments/attempts/:id/submit.
 * Matches payments.submit.v1.contract.ts output exactly.
 */
export type PaymentAttemptStatus =
  | "CREATED_INTENT"
  | "PENDING_UNVERIFIED"
  | "CREDITED"
  | "REJECTED"
  | "FAILED";

// ============================================================================
// Error Codes (Backend → Frontend)
// ============================================================================

/**
 * Payment error codes from backend.
 * Canonical source - core/payments/model.ts imports from here.
 */
export type PaymentErrorCode =
  | "SENDER_MISMATCH"
  | "INVALID_TOKEN"
  | "INVALID_RECIPIENT"
  | "INVALID_CHAIN"
  | "INSUFFICIENT_AMOUNT"
  | "INSUFFICIENT_CONFIRMATIONS"
  | "TX_NOT_FOUND"
  | "TX_REVERTED"
  | "TOKEN_TRANSFER_NOT_FOUND"
  | "RECIPIENT_MISMATCH"
  | "RECEIPT_NOT_FOUND"
  | "INTENT_EXPIRED"
  | "RPC_ERROR";

// ============================================================================
// Payment Amount Bounds
// ============================================================================

/** Minimum payment amount in USD cents ($2.00) — matches operator wallet floor */
export const MIN_PAYMENT_CENTS = 200;

/** Maximum payment amount in USD cents ($10,000.00) */
export const MAX_PAYMENT_CENTS = 1_000_000;
