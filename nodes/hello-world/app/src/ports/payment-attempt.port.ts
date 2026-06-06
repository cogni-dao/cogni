// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/payment-attempt`
 * Purpose: Payment attempt repository ports for persistence and audit logging, split by trust boundary.
 * Scope: Defines contracts for payment attempt lifecycle and event logging. Does not implement persistence logic.
 * Invariants:
 * - PaymentAttemptUserRepository: RLS-enforced via withTenantScope; UserId bound at construction.
 * - PaymentAttemptServiceRepository: BYPASSRLS; service methods include billingAccountId anchor for defense-in-depth.
 * - findById enforces ownership; service mutators verify billingAccountId in the same query.
 * - Attempts are immutable once txHash is bound.
 * Side-effects: none (interface definition only)
 * Notes: Adapters throw port-level errors; feature layer translates to domain errors.
 * Links: Implemented by UserDrizzlePaymentAttemptRepository + ServiceDrizzlePaymentAttemptRepository
 * @public
 */

import type {
  PaymentAttempt,
  PaymentAttemptStatus,
  PaymentErrorCode,
} from "@cogni/node-core";

// Re-export core types so adapters don't import from @/core directly
export type {
  PaymentAttempt,
  PaymentAttemptStatus,
  PaymentErrorCode,
} from "@cogni/node-core";

/**
 * Port-level error thrown when payment attempt is not found
 * Adapters throw this when attempt doesn't exist or ownership check fails
 */
export class PaymentAttemptNotFoundPortError extends Error {
  constructor(
    public readonly attemptId: string,
    public readonly billingAccountId?: string
  ) {
    const message = billingAccountId
      ? `Payment attempt ${attemptId} not found for billing account ${billingAccountId}`
      : `Payment attempt ${attemptId} not found`;
    super(message);
    this.name = "PaymentAttemptNotFoundPortError";
  }
}

/**
 * Port-level error thrown when txHash is already bound to different attempt
 * Prevents same transaction from being used across multiple payment attempts
 */
export class TxHashAlreadyBoundPortError extends Error {
  constructor(
    public readonly txHash: string,
    public readonly chainId: number,
    public readonly existingAttemptId: string
  ) {
    super(
      `Transaction hash ${txHash} on chain ${chainId} already bound to attempt ${existingAttemptId}`
    );
    this.name = "TxHashAlreadyBoundPortError";
  }
}

/**
 * Type guard for PaymentAttemptNotFoundPortError
 */
export function isPaymentAttemptNotFoundPortError(
  error: unknown
): error is PaymentAttemptNotFoundPortError {
  return (
    error instanceof Error && error.name === "PaymentAttemptNotFoundPortError"
  );
}

/**
 * Type guard for TxHashAlreadyBoundPortError
 */
export function isTxHashAlreadyBoundPortError(
  error: unknown
): error is TxHashAlreadyBoundPortError {
  return error instanceof Error && error.name === "TxHashAlreadyBoundPortError";
}

/**
 * Parameters for creating a payment attempt
 */
export interface CreatePaymentAttemptParams {
  billingAccountId: string;
  fromAddress: string;
  chainId: number;
  token: string;
  toAddress: string;
  amountRaw: bigint;
  amountUsdCents: number;
  expiresAt: Date;
}

/**
 * Parameters for logging a payment event
 * eventType is a coarse-grained operation verb; fromStatus/toStatus carry actual state transitions
 */
export interface LogPaymentEventParams {
  attemptId: string;
  eventType:
    | "INTENT_CREATED"
    | "TX_SUBMITTED"
    | "VERIFICATION_ATTEMPTED"
    | "STATUS_CHANGED";
  fromStatus: PaymentAttemptStatus | null;
  toStatus: PaymentAttemptStatus;
  errorCode?: PaymentErrorCode;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// User-facing port (RLS enforced, UserId bound at construction)
// ---------------------------------------------------------------------------

/**
 * User-scoped payment attempt repository.
 * Adapter wraps all queries in withTenantScope for RLS enforcement.
 * Only exposes methods that operate within a single tenant's billing accounts.
 */
export interface PaymentAttemptUserRepository {
  /**
   * Creates a new payment attempt within the tenant's billing account.
   * Sets status to CREATED_INTENT and generates unique ID.
   * RLS ensures billingAccountId belongs to the scoped user.
   */
  create(params: CreatePaymentAttemptParams): Promise<PaymentAttempt>;

  /**
   * Finds payment attempt by ID with ownership enforcement.
   * Returns null if not found or not owned by billingAccountId.
   * RLS provides additional tenant isolation beyond the billingAccountId filter.
   */
  findById(
    id: string,
    billingAccountId: string
  ): Promise<PaymentAttempt | null>;
}

// ---------------------------------------------------------------------------
// Service port (BYPASSRLS — cross-user lookups and internal mutations)
// ---------------------------------------------------------------------------

/**
 * Service-scoped payment attempt repository.
 * Adapter uses serviceDb (BYPASSRLS) for cross-user lookups and internal mutations.
 * Mutating methods include billingAccountId as defense-in-depth tenant anchor
 * (even though caller already verified ownership via findById on the user repo).
 */
export interface PaymentAttemptServiceRepository {
  /**
   * Finds payment attempt by transaction hash (cross-user lookup).
   * Used for duplicate detection and idempotency checks.
   * Must be cross-user to detect txHash reuse across tenants.
   */
  findByTxHash(chainId: number, txHash: string): Promise<PaymentAttempt | null>;

  /**
   * Updates payment attempt status with tenant anchor.
   * Feature service validates transitions via core/rules.isValidTransition().
   * billingAccountId included in WHERE clause as defense-in-depth.
   *
   * @throws PaymentAttemptNotFoundPortError if not found or billingAccountId mismatch
   */
  updateStatus(
    id: string,
    billingAccountId: string,
    status: PaymentAttemptStatus,
    errorCode?: PaymentErrorCode
  ): Promise<PaymentAttempt>;

  /**
   * Binds transaction hash to payment attempt with tenant anchor.
   * Sets txHash, submittedAt, and clears expiresAt.
   * Cross-user duplicate detection remains unscoped (correct for security).
   * billingAccountId included in update WHERE clause as defense-in-depth.
   *
   * @throws PaymentAttemptNotFoundPortError if not found or billingAccountId mismatch
   * @throws TxHashAlreadyBoundPortError if hash already used
   */
  bindTxHash(
    id: string,
    billingAccountId: string,
    txHash: string,
    submittedAt: Date
  ): Promise<PaymentAttempt>;

  /**
   * Records verification attempt with tenant anchor.
   * Updates lastVerifyAttemptAt and increments verifyAttemptCount.
   * billingAccountId included in WHERE clause as defense-in-depth.
   */
  recordVerificationAttempt(
    id: string,
    billingAccountId: string,
    attemptedAt: Date
  ): Promise<PaymentAttempt>;
}

/**
 * @deprecated Use PaymentAttemptUserRepository + PaymentAttemptServiceRepository.
 * Retained temporarily as a type alias to reduce scope explosion.
 * Will be removed in the next commit.
 */
export type PaymentAttemptRepository = PaymentAttemptUserRepository &
  PaymentAttemptServiceRepository;
