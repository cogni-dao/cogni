// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/services/paymentService`
 * Purpose: Orchestrate payment attempt lifecycle via ports. Handles intent creation, txHash submission, status polling, settlement, and post-credit funding.
 * Scope: Feature-layer orchestration for payment attempts; validates state transitions, enforces TTLs, triggers post-credit funding on CREDITED; does not expose HTTP handling.
 * Invariants: State transitions via core/rules; atomic settlement via confirmCreditsPayment; post-credit funding via runPostCreditFunding (fires exactly once on CREDITED transition); RPC_ERROR is transient (retried on next poll).
 * Side-effects: IO (via AccountService, ServiceAccountService, PaymentAttemptUserRepository, PaymentAttemptServiceRepository, OnChainVerifier, PostCreditFundingDeps ports)
 * Notes: RPC_ERROR from OnChainVerifier leaves attempt in PENDING_UNVERIFIED for automatic retry via getStatus polling. Post-credit funding (treasury settlement, TB co-writes, provider top-up) runs inline after CREDITED but never throws — all steps catch internally.
 * Links: docs/spec/payments-design.md
 * @public
 */

import type {
  PaymentAttempt,
  PaymentAttemptStatus,
  PaymentErrorCode,
} from "@cogni/node-core";
import {
  isIntentExpired,
  isValidPaymentAmount,
  isValidTransition,
  isVerificationTimedOut,
  MAX_PAYMENT_CENTS,
  MIN_PAYMENT_CENTS,
  PAYMENT_INTENT_TTL_MS,
  toClientVisibleStatus,
  usdCentsToRawUsdc,
} from "@cogni/node-core";
import type {
  AccountService,
  Clock,
  OnChainVerifier,
  PaymentAttemptServiceRepository,
  PaymentAttemptUserRepository,
  ServiceAccountService,
} from "@/ports";
import { getPaymentConfig } from "@/shared/config/repoSpec.server";
import type { Logger } from "@/shared/observability";
import { USDC_TOKEN_ADDRESS, VERIFY_THROTTLE_SECONDS } from "@/shared/web3";
import type { PostCreditFundingDeps } from "../application/confirmCreditsPurchase";
import { runPostCreditFunding } from "../application/confirmCreditsPurchase";
import { PaymentNotFoundError } from "../errors";
import { confirmCreditsPayment } from "./creditsConfirm";

// ============================================================================
// Public Types
// ============================================================================

export interface CreateIntentInput {
  billingAccountId: string;
  fromAddress: string; // SIWE wallet address (checksummed via getAddress())
  amountUsdCents: number;
}

export interface CreateIntentResult {
  attemptId: string;
  chainId: number;
  token: string;
  to: string;
  amountRaw: string; // bigint serialized as string for JSON
  amountUsdCents: number;
  expiresAt: Date;
}

export interface SubmitTxHashInput {
  attemptId: string;
  billingAccountId: string;
  defaultVirtualKeyId: string;
  txHash: string;
}

export interface SubmitTxHashResult {
  attemptId: string;
  status: PaymentAttemptStatus;
  chainId: number;
  txHash: string;
  errorCode?: PaymentErrorCode | undefined;
  errorMessage?: string | undefined;
}

export interface GetStatusInput {
  attemptId: string;
  billingAccountId: string;
  defaultVirtualKeyId: string;
}

export interface GetStatusResult {
  attemptId: string;
  status: PaymentAttemptStatus;
  chainId: number;
  clientStatus: string; // ClientVisibleStatus from core
  txHash: string | null;
  amountUsdCents: number;
  errorCode?: PaymentErrorCode | undefined;
  createdAt: Date;
}

// ============================================================================
// Create Intent
// ============================================================================

/**
 * Creates payment intent with on-chain transfer parameters
 * Validates amount, resolves widget config, creates attempt in CREATED_INTENT state
 *
 * @param userRepo - User-scoped PaymentAttemptUserRepository (RLS enforced)
 * @param clock - Clock port for deterministic timestamps
 * @param input - Intent parameters (billing account, from address, amount)
 * @returns Intent details with on-chain transfer params (token, to, amountRaw, etc.)
 * @throws Error if amount is invalid
 */
export async function createIntent(
  userRepo: PaymentAttemptUserRepository,
  clock: Clock,
  input: CreateIntentInput
): Promise<CreateIntentResult> {
  if (!isValidPaymentAmount(input.amountUsdCents)) {
    throw new Error(
      `Invalid payment amount: ${input.amountUsdCents} cents. Must be between ${MIN_PAYMENT_CENTS} and ${MAX_PAYMENT_CENTS} cents.`
    );
  }

  const paymentConfig = getPaymentConfig();
  if (!paymentConfig) {
    throw new Error(
      "Payment rails not activated. Run `pnpm node:activate-payments` first."
    );
  }
  const { chainId, receivingAddress } = paymentConfig;
  const token = USDC_TOKEN_ADDRESS;
  const amountRaw = usdCentsToRawUsdc(input.amountUsdCents);

  const now = new Date(clock.now());
  const expiresAt = new Date(now.getTime() + PAYMENT_INTENT_TTL_MS);

  const attempt = await userRepo.create({
    billingAccountId: input.billingAccountId,
    fromAddress: input.fromAddress,
    chainId,
    token,
    toAddress: receivingAddress,
    amountRaw,
    amountUsdCents: input.amountUsdCents,
    expiresAt,
  });

  if (!attempt.expiresAt) {
    throw new Error("Internal error: expiresAt is null for CREATED_INTENT");
  }

  return {
    attemptId: attempt.id,
    chainId: attempt.chainId,
    token: attempt.token,
    to: attempt.toAddress,
    amountRaw: attempt.amountRaw.toString(),
    amountUsdCents: attempt.amountUsdCents,
    expiresAt: attempt.expiresAt,
  };
}

// ============================================================================
// Submit TxHash
// ============================================================================

/**
 * Submits transaction hash for verification
 * Binds txHash to attempt, checks expiration, initiates verification
 *
 * @param userRepo - User-scoped PaymentAttemptUserRepository (RLS enforced, for findById)
 * @param serviceRepo - Service-scoped PaymentAttemptServiceRepository (BYPASSRLS, for mutations)
 * @param accountService - AccountService port for settlement
 * @param onChainVerifier - OnChainVerifier port for verification
 * @param clock - Clock port for timestamps
 * @param input - Submission parameters (attemptId, billingAccountId, txHash)
 * @returns Current attempt status with error details if failed
 * @throws PaymentAttemptNotFoundPortError if attempt not found or not owned
 * @throws TxHashAlreadyBoundPortError if txHash already bound to different attempt
 */
export async function submitTxHash(
  userRepo: PaymentAttemptUserRepository,
  serviceRepo: PaymentAttemptServiceRepository,
  accountService: AccountService,
  serviceAccountService: ServiceAccountService,
  onChainVerifier: OnChainVerifier,
  clock: Clock,
  log: Logger,
  input: SubmitTxHashInput,
  postCreditFundingDeps?: PostCreditFundingDeps
): Promise<SubmitTxHashResult> {
  const now = new Date(clock.now());

  let attempt = await userRepo.findById(
    input.attemptId,
    input.billingAccountId
  );
  if (!attempt) {
    throw new PaymentNotFoundError(input.attemptId, input.billingAccountId);
  }

  if (attempt.txHash === input.txHash) {
    return {
      attemptId: attempt.id,
      status: attempt.status,
      chainId: attempt.chainId,
      txHash: attempt.txHash,
      errorCode: attempt.errorCode ?? undefined,
      errorMessage: attempt.errorCode
        ? `Payment ${attempt.status.toLowerCase()}: ${attempt.errorCode}`
        : undefined,
    };
  }

  if (isIntentExpired(attempt, now)) {
    if (isValidTransition(attempt.status, "FAILED")) {
      attempt = await serviceRepo.updateStatus(
        attempt.id,
        attempt.billingAccountId,
        "FAILED",
        "INTENT_EXPIRED"
      );
    }

    return {
      attemptId: attempt.id,
      status: attempt.status,
      chainId: attempt.chainId,
      txHash: attempt.txHash ?? input.txHash,
      errorCode: "INTENT_EXPIRED",
      errorMessage: "Payment intent expired before transaction submission",
    };
  }

  attempt = await serviceRepo.bindTxHash(
    attempt.id,
    attempt.billingAccountId,
    input.txHash,
    now
  );

  attempt = await verifyAndSettle(
    attempt,
    serviceRepo,
    accountService,
    serviceAccountService,
    onChainVerifier,
    clock,
    log,
    input.defaultVirtualKeyId,
    postCreditFundingDeps
  );

  if (!attempt.txHash) {
    throw new Error("Internal error: txHash is null after bind operation");
  }

  return {
    attemptId: attempt.id,
    status: attempt.status,
    chainId: attempt.chainId,
    txHash: attempt.txHash,
    errorCode: attempt.errorCode ?? undefined,
    errorMessage: attempt.errorCode
      ? `Payment ${attempt.status.toLowerCase()}: ${attempt.errorCode}`
      : undefined,
  };
}

// ============================================================================
// Get Status
// ============================================================================

/**
 * Retrieves payment attempt status with throttled verification
 * Checks expiration, verification timeout, throttles verification attempts
 *
 * @param userRepo - User-scoped PaymentAttemptUserRepository (RLS enforced, for findById)
 * @param serviceRepo - Service-scoped PaymentAttemptServiceRepository (BYPASSRLS, for mutations)
 * @param accountService - AccountService port for settlement
 * @param onChainVerifier - OnChainVerifier port for verification
 * @param clock - Clock port for timestamps
 * @param input - Query parameters (attemptId, billingAccountId)
 * @returns Current status with client-visible status mapping
 * @throws PaymentAttemptNotFoundPortError if attempt not found or not owned
 */
export async function getStatus(
  userRepo: PaymentAttemptUserRepository,
  serviceRepo: PaymentAttemptServiceRepository,
  accountService: AccountService,
  serviceAccountService: ServiceAccountService,
  onChainVerifier: OnChainVerifier,
  clock: Clock,
  log: Logger,
  input: GetStatusInput,
  postCreditFundingDeps?: PostCreditFundingDeps
): Promise<GetStatusResult> {
  const now = new Date(clock.now());

  let attempt = await userRepo.findById(
    input.attemptId,
    input.billingAccountId
  );
  if (!attempt) {
    throw new PaymentNotFoundError(input.attemptId, input.billingAccountId);
  }

  if (attempt.status === "CREATED_INTENT" && isIntentExpired(attempt, now)) {
    if (isValidTransition(attempt.status, "FAILED")) {
      attempt = await serviceRepo.updateStatus(
        attempt.id,
        attempt.billingAccountId,
        "FAILED",
        "INTENT_EXPIRED"
      );
    }
  }

  if (
    attempt.status === "PENDING_UNVERIFIED" &&
    isVerificationTimedOut(attempt, now)
  ) {
    if (isValidTransition(attempt.status, "FAILED")) {
      attempt = await serviceRepo.updateStatus(
        attempt.id,
        attempt.billingAccountId,
        "FAILED",
        "RECEIPT_NOT_FOUND"
      );
    }
  }

  if (attempt.status === "PENDING_UNVERIFIED") {
    const shouldVerify =
      !attempt.lastVerifyAttemptAt ||
      now.getTime() - attempt.lastVerifyAttemptAt.getTime() >=
        VERIFY_THROTTLE_SECONDS * 1000;

    if (shouldVerify) {
      attempt = await serviceRepo.recordVerificationAttempt(
        attempt.id,
        attempt.billingAccountId,
        now
      );

      attempt = await verifyAndSettle(
        attempt,
        serviceRepo,
        accountService,
        serviceAccountService,
        onChainVerifier,
        clock,
        log,
        input.defaultVirtualKeyId,
        postCreditFundingDeps
      );
    }
  }

  return {
    attemptId: attempt.id,
    status: attempt.status,
    chainId: attempt.chainId,
    clientStatus: toClientVisibleStatus(attempt.status),
    txHash: attempt.txHash,
    amountUsdCents: attempt.amountUsdCents,
    errorCode: attempt.errorCode ?? undefined,
    createdAt: attempt.createdAt,
  };
}

// ============================================================================
// Verify and Settle (Private)
// ============================================================================

/**
 * Verifies on-chain transaction and settles payment if valid
 * Calls OnChainVerifier port, validates sender (Phase 3), settles via confirmCreditsPayment
 *
 * @param attempt - Current payment attempt
 * @param serviceRepo - Service-scoped PaymentAttemptServiceRepository (BYPASSRLS)
 * @param accountService - AccountService port for settlement
 * @param onChainVerifier - OnChainVerifier port for verification
 * @param clock - Clock port for timestamps
 * @returns Updated payment attempt after verification/settlement
 */
async function verifyAndSettle(
  attempt: PaymentAttempt,
  serviceRepo: PaymentAttemptServiceRepository,
  accountService: AccountService,
  serviceAccountService: ServiceAccountService,
  onChainVerifier: OnChainVerifier,
  _clock: Clock,
  log: Logger,
  defaultVirtualKeyId: string,
  postCreditFundingDeps?: PostCreditFundingDeps
): Promise<PaymentAttempt> {
  if (!attempt.txHash) {
    return attempt;
  }

  // Call OnChainVerifier port
  const verificationResult = await onChainVerifier.verify({
    chainId: attempt.chainId,
    txHash: attempt.txHash,
    expectedTo: attempt.toAddress,
    expectedToken: attempt.token,
    expectedAmount: attempt.amountRaw,
  });

  if (verificationResult.status === "PENDING") {
    return attempt;
  }

  if (verificationResult.status === "FAILED") {
    const errorCode = verificationResult.errorCode ?? "TX_REVERTED";

    // RPC_ERROR is transient — leave in PENDING_UNVERIFIED so next poll retries
    if (errorCode === "RPC_ERROR") {
      log.warn(
        { attemptId: attempt.id, txHash: attempt.txHash, errorCode },
        "RPC error during verification — will retry on next poll"
      );
      return attempt;
    }

    const targetStatus: PaymentAttemptStatus =
      errorCode === "TX_REVERTED" ? "FAILED" : "REJECTED";

    if (isValidTransition(attempt.status, targetStatus)) {
      attempt = await serviceRepo.updateStatus(
        attempt.id,
        attempt.billingAccountId,
        targetStatus,
        errorCode
      );
    }

    return attempt;
  }

  if (verificationResult.status === "VERIFIED") {
    if (
      verificationResult.actualFrom &&
      verificationResult.actualFrom.toLowerCase() !==
        attempt.fromAddress.toLowerCase()
    ) {
      if (isValidTransition(attempt.status, "REJECTED")) {
        attempt = await serviceRepo.updateStatus(
          attempt.id,
          attempt.billingAccountId,
          "REJECTED",
          "SENDER_MISMATCH"
        );
      }

      return attempt;
    }

    const clientPaymentId = `${attempt.chainId}:${attempt.txHash}`;

    try {
      await confirmCreditsPayment(accountService, serviceAccountService, {
        billingAccountId: attempt.billingAccountId,
        defaultVirtualKeyId,
        amountUsdCents: attempt.amountUsdCents,
        clientPaymentId,
        metadata: {
          paymentAttemptId: attempt.id,
          txHash: attempt.txHash,
          chainId: attempt.chainId,
          fromAddress: attempt.fromAddress,
        },
      });

      if (isValidTransition(attempt.status, "CREDITED")) {
        attempt = await serviceRepo.updateStatus(
          attempt.id,
          attempt.billingAccountId,
          "CREDITED"
        );

        // Post-credit funding: treasury settlement + TB co-writes + provider top-up
        // Runs inline (not fire-and-forget) but never throws (all steps catch internally).
        // Uses chainId:txHash as canonical funding key (matches clientPaymentId used for crediting).
        if (postCreditFundingDeps) {
          await runPostCreditFunding(postCreditFundingDeps, {
            paymentIntentId: clientPaymentId,
            amountUsdCents: attempt.amountUsdCents,
          });
        }
      }
    } catch (error) {
      log.error(
        {
          attemptId: attempt.id,
          error: error instanceof Error ? error.message : error,
        },
        "Settlement failed for payment attempt"
      );
    }

    return attempt;
  }

  return attempt;
}
