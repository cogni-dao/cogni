// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/payments/payment-builders`
 * Purpose: Builder functions for creating test PaymentAttempt data with deterministic defaults.
 * Scope: Test fixture utilities. Does NOT perform I/O or interact with external dependencies.
 * Invariants: Provides sensible defaults for all fields; supports partial overrides for test scenarios.
 * Side-effects: none (pure data builders)
 * Notes: Uses deterministic values for repeatability; follows pattern from ai/message-builders.
 * Links: core/payments/model
 * @public
 */

import type {
  PaymentAttempt,
  PaymentAttemptStatus,
  PaymentErrorCode,
} from "@cogni/node-core";
import {
  PAYMENT_INTENT_TTL_MS,
  PENDING_UNVERIFIED_TTL_MS,
} from "@cogni/node-core";
import { CHAIN_ID, USDC_TOKEN_ADDRESS } from "@cogni/node-shared";

/**
 * Options for creating a PaymentAttempt test fixture
 * All fields are optional and will use deterministic defaults
 */
export interface PaymentAttemptOptions {
  id?: string;
  billingAccountId?: string;
  fromAddress?: string;
  chainId?: number;
  token?: string;
  toAddress?: string;
  amountRaw?: bigint;
  amountUsdCents?: number;
  status?: PaymentAttemptStatus;
  txHash?: string | null;
  errorCode?: PaymentErrorCode | null;
  expiresAt?: Date | null;
  submittedAt?: Date | null;
  lastVerifyAttemptAt?: Date | null;
  verifyAttemptCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Default timestamp for deterministic tests
 * 2025-01-01T00:00:00.000Z
 */
const DEFAULT_TIMESTAMP = new Date("2025-01-01T00:00:00.000Z");

/**
 * Default chain ID from active chain config
 */
const DEFAULT_CHAIN_ID = CHAIN_ID;

/**
 * Default USDC token address from active chain config
 */
const DEFAULT_TOKEN = USDC_TOKEN_ADDRESS;

/**
 * Default DAO wallet address (test fixture)
 */
const DEFAULT_DAO_WALLET = "0x0702e6969ec03f30cf3684c802b264c68a61d219";

/**
 * Default sender wallet address (checksummed test fixture)
 */
const DEFAULT_FROM_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/**
 * Creates a PaymentAttempt with deterministic defaults
 * All fields can be overridden via options
 *
 * @param options - Partial overrides for specific test scenarios
 * @returns PaymentAttempt with defaults applied
 */
export function createPaymentAttempt(
  options: PaymentAttemptOptions = {}
): PaymentAttempt {
  return {
    id: options.id ?? "test-attempt-id-1",
    billingAccountId: options.billingAccountId ?? "test-billing-account-1",
    fromAddress: options.fromAddress ?? DEFAULT_FROM_ADDRESS,
    chainId: options.chainId ?? DEFAULT_CHAIN_ID,
    token: options.token ?? DEFAULT_TOKEN,
    toAddress: options.toAddress ?? DEFAULT_DAO_WALLET,
    amountRaw: options.amountRaw ?? 5_000_000n, // $5.00
    amountUsdCents: options.amountUsdCents ?? 500, // $5.00
    status: options.status ?? "CREATED_INTENT",
    txHash: options.txHash ?? null,
    errorCode: options.errorCode ?? null,
    expiresAt: options.expiresAt ?? null,
    submittedAt: options.submittedAt ?? null,
    lastVerifyAttemptAt: options.lastVerifyAttemptAt ?? null,
    verifyAttemptCount: options.verifyAttemptCount ?? 0,
    createdAt: options.createdAt ?? DEFAULT_TIMESTAMP,
  };
}

/**
 * Creates a PaymentAttempt in CREATED_INTENT state
 * Includes expiresAt (30 minutes from creation), no txHash
 *
 * @param options - Partial overrides
 * @returns PaymentAttempt in CREATED_INTENT state
 */
export function createIntentAttempt(
  options: Partial<PaymentAttemptOptions> = {}
): PaymentAttempt {
  const createdAt = options.createdAt ?? DEFAULT_TIMESTAMP;
  const expiresAt = new Date(createdAt.getTime() + PAYMENT_INTENT_TTL_MS);

  return createPaymentAttempt({
    ...options,
    status: "CREATED_INTENT",
    expiresAt,
    txHash: null,
    submittedAt: null,
    lastVerifyAttemptAt: null,
    verifyAttemptCount: 0,
  });
}

/**
 * Creates a PaymentAttempt in PENDING_UNVERIFIED state
 * Includes txHash, submittedAt, no expiresAt
 *
 * @param options - Partial overrides
 * @returns PaymentAttempt in PENDING_UNVERIFIED state
 */
export function createPendingAttempt(
  options: Partial<PaymentAttemptOptions> = {}
): PaymentAttempt {
  const submittedAt = options.submittedAt ?? DEFAULT_TIMESTAMP;

  return createPaymentAttempt({
    ...options,
    status: "PENDING_UNVERIFIED",
    txHash:
      options.txHash ??
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    submittedAt,
    expiresAt: null, // Cleared on submission
    lastVerifyAttemptAt: options.lastVerifyAttemptAt ?? null,
    verifyAttemptCount: options.verifyAttemptCount ?? 0,
  });
}

/**
 * Creates a PaymentAttempt in CREDITED state (terminal success)
 *
 * @param options - Partial overrides
 * @returns PaymentAttempt in CREDITED state
 */
export function createCreditedAttempt(
  options: Partial<PaymentAttemptOptions> = {}
): PaymentAttempt {
  return createPaymentAttempt({
    ...options,
    status: "CREDITED",
    txHash:
      options.txHash ??
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    submittedAt: options.submittedAt ?? DEFAULT_TIMESTAMP,
    expiresAt: null,
  });
}

/**
 * Creates a PaymentAttempt in REJECTED state (terminal failure)
 * Includes errorCode (defaults to SENDER_MISMATCH)
 *
 * @param options - Partial overrides
 * @returns PaymentAttempt in REJECTED state
 */
export function createRejectedAttempt(
  options: Partial<PaymentAttemptOptions> = {}
): PaymentAttempt {
  return createPaymentAttempt({
    ...options,
    status: "REJECTED",
    txHash:
      options.txHash ??
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    errorCode: options.errorCode ?? "SENDER_MISMATCH",
    submittedAt: options.submittedAt ?? DEFAULT_TIMESTAMP,
    expiresAt: null,
  });
}

/**
 * Creates a PaymentAttempt in FAILED state (terminal failure)
 * Includes errorCode (defaults to INTENT_EXPIRED)
 *
 * @param options - Partial overrides
 * @returns PaymentAttempt in FAILED state
 */
export function createFailedAttempt(
  options: Partial<PaymentAttemptOptions> = {}
): PaymentAttempt {
  return createPaymentAttempt({
    ...options,
    status: "FAILED",
    errorCode: options.errorCode ?? "INTENT_EXPIRED",
  });
}

/**
 * Creates an expired intent attempt
 * expiresAt is in the past relative to provided now timestamp
 *
 * @param now - Current timestamp for expiration calculation
 * @param options - Partial overrides
 * @returns PaymentAttempt with expired intent
 */
export function createExpiredIntent(
  now: Date,
  options: Partial<PaymentAttemptOptions> = {}
): PaymentAttempt {
  // Set expiresAt to 1 hour before now (well past 30min TTL)
  const expiresAt = new Date(now.getTime() - 60 * 60 * 1000);
  const createdAt = new Date(expiresAt.getTime() - PAYMENT_INTENT_TTL_MS);

  return createPaymentAttempt({
    ...options,
    status: "CREATED_INTENT",
    expiresAt,
    createdAt,
    updatedAt: createdAt,
    txHash: null,
    submittedAt: null,
  });
}

/**
 * Creates a timed-out pending attempt
 * submittedAt is >24h ago relative to provided now timestamp
 *
 * @param now - Current timestamp for timeout calculation
 * @param options - Partial overrides
 * @returns PaymentAttempt with timed-out verification
 */
export function createTimedOutPending(
  now: Date,
  options: Partial<PaymentAttemptOptions> = {}
): PaymentAttempt {
  // Set submittedAt to 25 hours before now (past 24h timeout)
  const submittedAt = new Date(
    now.getTime() - PENDING_UNVERIFIED_TTL_MS - 60 * 60 * 1000
  );

  return createPaymentAttempt({
    ...options,
    status: "PENDING_UNVERIFIED",
    txHash:
      options.txHash ??
      "0x9999999999999999999999999999999999999999999999999999999999999999",
    submittedAt,
    expiresAt: null,
    createdAt: submittedAt,
    updatedAt: submittedAt,
    verifyAttemptCount: options.verifyAttemptCount ?? 10, // Multiple attempts
  });
}
