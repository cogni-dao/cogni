// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/payments/attempts.server`
 * Purpose: App-layer wiring for payment attempts. Resolves dependencies (including post-credit funding deps), delegates to feature services, and maps port types to contract DTOs.
 * Scope: Server-only facade. Handles billing account resolution from session user, builds PostCreditFundingDeps from container, maps Date to ISO string for contract compliance; does not perform direct persistence or HTTP handling.
 * Invariants: Billing account from session only; state transition events include chainId and errorCode; post-credit funding deps threaded to service layer (not invoked in facade).
 * Side-effects: IO (via PaymentAttemptUserRepository, PaymentAttemptServiceRepository, AccountService, ServiceAccountService, OnChainVerifier, PostCreditFundingDeps ports).
 * Notes: Facades own DTO mapping. Emits payments.verified on CREDITED transitions. buildPostCreditFundingDeps() constructs funding deps from container when at least one downstream port is available.
 * Links: docs/spec/payments-design.md, src/contracts/AGENTS.md
 * @public
 */

import { toUserId } from "@cogni/ids";
import type {
  PaymentIntentOutput,
  PaymentStatusOutput,
  PaymentSubmitOutput,
} from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { getAddress } from "viem";
import { type Container, getContainer } from "@/bootstrap/container";
import type { PostCreditFundingDeps } from "@/features/payments/application/confirmCreditsPurchase";
import {
  AuthUserNotFoundError,
  WalletRequiredError,
} from "@/features/payments/errors";
import {
  createIntent,
  getStatus,
  submitTxHash,
} from "@/features/payments/services/paymentService";
import { getOrCreateBillingAccountForUser } from "@/lib/auth/mapping";
import { serverEnv } from "@/shared/env/server-env";
import type {
  PaymentsIntentCreatedEvent,
  PaymentsStateTransitionEvent,
  PaymentsStatusReadEvent,
  PaymentsVerifiedEvent,
  RequestContext,
} from "@/shared/observability";

/**
 * Build PostCreditFundingDeps from the container.
 * Returns undefined when provider funding is not configured (no-op at service layer).
 */
function buildPostCreditFundingDeps(
  container: Container,
  log: PostCreditFundingDeps["log"]
): PostCreditFundingDeps | undefined {
  // Only build deps when at least one downstream port is available
  if (
    !container.treasurySettlement &&
    !container.financialLedger &&
    !container.providerFunding
  ) {
    return undefined;
  }

  const pricingConfig = (() => {
    if (!container.providerFunding) return undefined;
    const env = serverEnv();
    return {
      markupFactor: env.USER_PRICE_MARKUP_FACTOR,
      revenueShare: env.SYSTEM_TENANT_REVENUE_SHARE,
      cryptoFee: env.OPENROUTER_CRYPTO_FEE,
    };
  })();

  return {
    treasurySettlement: container.treasurySettlement,
    financialLedger: container.financialLedger,
    providerFunding: container.providerFunding,
    log,
    pricingConfig,
  };
}

/**
 * Creates payment intent facade
 * Resolves billing account from session, delegates to feature service
 *
 * @param params - Session user and payment amount
 * @param ctx - Request context for logging
 * @returns Payment intent with on-chain transfer parameters
 * @throws Error if user not provisioned or amount invalid
 */
export async function createPaymentIntentFacade(
  params: {
    sessionUser: SessionUser;
    amountUsdCents: number;
  },
  ctx: RequestContext
): Promise<PaymentIntentOutput> {
  const start = performance.now();
  const container = getContainer();
  const accountService = container.accountsForUser(
    toUserId(params.sessionUser.id)
  );
  const userRepo = container.paymentAttemptsForUser(
    toUserId(params.sessionUser.id)
  );
  const { clock } = container;

  let billingAccount: Awaited<
    ReturnType<typeof getOrCreateBillingAccountForUser>
  >;
  try {
    billingAccount = await getOrCreateBillingAccountForUser(accountService, {
      userId: params.sessionUser.id,
      ...(params.sessionUser.walletAddress
        ? { walletAddress: params.sessionUser.walletAddress }
        : {}),
    });
  } catch (error) {
    // Check for FK constraint violation (user not found in DB)
    // Drizzle wraps Postgres errors - constraint name is in cause.message
    if (
      error &&
      typeof error === "object" &&
      "cause" in error &&
      error.cause instanceof Error &&
      error.cause.message.includes("billing_accounts_owner_user_id_users_id_fk")
    ) {
      throw new AuthUserNotFoundError(params.sessionUser.id);
    }
    throw error;
  }

  // Enrich context with business identifiers
  const enrichedCtx: RequestContext = {
    ...ctx,
    log: ctx.log.child({
      userId: params.sessionUser.id,
      billingAccountId: billingAccount.id,
    }),
  };

  if (!params.sessionUser.walletAddress) {
    throw new WalletRequiredError();
  }
  const fromAddress = getAddress(params.sessionUser.walletAddress);

  const result = await createIntent(userRepo, clock, {
    billingAccountId: billingAccount.id,
    fromAddress,
    amountUsdCents: params.amountUsdCents,
  });

  // Log domain event
  const event: PaymentsIntentCreatedEvent = {
    event: "payments.intent_created",
    routeId: ctx.routeId,
    reqId: ctx.reqId,
    billingAccountId: billingAccount.id,
    paymentIntentId: result.attemptId,
    chainId: result.chainId,
    durationMs: performance.now() - start,
  };
  enrichedCtx.log.info(event, "payment intent created");

  return {
    attemptId: result.attemptId,
    chainId: result.chainId,
    token: result.token,
    to: result.to,
    amountRaw: result.amountRaw,
    amountUsdCents: result.amountUsdCents,
    expiresAt: result.expiresAt.toISOString(),
  };
}

/**
 * Submits payment transaction hash facade
 * Resolves billing account from session, delegates to feature service
 *
 * @param params - Session user, attempt ID, and transaction hash
 * @param ctx - Request context for logging
 * @returns Payment status after submission and verification attempt
 * @throws Error if attempt not found or not owned
 */
export async function submitPaymentTxHashFacade(
  params: {
    sessionUser: SessionUser;
    attemptId: string;
    txHash: string;
  },
  ctx: RequestContext
): Promise<PaymentSubmitOutput> {
  const start = performance.now();
  const container = getContainer();
  const accountService = container.accountsForUser(
    toUserId(params.sessionUser.id)
  );
  const userRepo = container.paymentAttemptsForUser(
    toUserId(params.sessionUser.id)
  );
  const {
    paymentAttemptServiceRepository: serviceRepo,
    onChainVerifier,
    clock,
  } = container;

  let billingAccount: Awaited<
    ReturnType<typeof getOrCreateBillingAccountForUser>
  >;
  try {
    billingAccount = await getOrCreateBillingAccountForUser(accountService, {
      userId: params.sessionUser.id,
      ...(params.sessionUser.walletAddress
        ? { walletAddress: params.sessionUser.walletAddress }
        : {}),
    });
  } catch (error) {
    // Check for FK constraint violation (user not found in DB)
    // Drizzle wraps Postgres errors - constraint name is in cause.message
    if (
      error &&
      typeof error === "object" &&
      "cause" in error &&
      error.cause instanceof Error &&
      error.cause.message.includes("billing_accounts_owner_user_id_users_id_fk")
    ) {
      throw new AuthUserNotFoundError(params.sessionUser.id);
    }
    throw error;
  }

  // Enrich context with business identifiers
  const enrichedCtx: RequestContext = {
    ...ctx,
    log: ctx.log.child({
      userId: params.sessionUser.id,
      billingAccountId: billingAccount.id,
    }),
  };

  const result = await submitTxHash(
    userRepo,
    serviceRepo,
    accountService,
    container.serviceAccountService,
    onChainVerifier,
    clock,
    enrichedCtx.log,
    {
      attemptId: params.attemptId,
      billingAccountId: billingAccount.id,
      defaultVirtualKeyId: billingAccount.defaultVirtualKeyId,
      txHash: params.txHash,
    },
    buildPostCreditFundingDeps(container, enrichedCtx.log)
  );

  // Log domain event (state transition)
  const event: PaymentsStateTransitionEvent = {
    event: "payments.state_transition",
    routeId: ctx.routeId,
    reqId: ctx.reqId,
    billingAccountId: billingAccount.id,
    paymentIntentId: result.attemptId,
    toStatus: result.status,
    chainId: result.chainId,
    txHash: result.txHash,
    errorCode: result.errorCode,
    durationMs: performance.now() - start,
  };
  enrichedCtx.log.info(event, "payment state transition");

  // Emit verified event when submit triggers immediate verification + settlement
  if (result.status === "CREDITED") {
    const verifiedEvent: PaymentsVerifiedEvent = {
      event: "payments.verified",
      routeId: ctx.routeId,
      reqId: ctx.reqId,
      billingAccountId: billingAccount.id,
      paymentIntentId: result.attemptId,
      chainId: result.chainId,
      txHash: result.txHash,
      durationMs: performance.now() - start,
    };
    enrichedCtx.log.info(verifiedEvent, "payment verified and credited");
  }

  return {
    attemptId: result.attemptId,
    status: result.status,
    txHash: result.txHash,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  };
}

/**
 * Gets payment status facade
 * Resolves billing account from session, delegates to feature service
 *
 * @param params - Session user and attempt ID
 * @param ctx - Request context for logging
 * @returns Payment status with client-visible status mapping
 * @throws Error if attempt not found or not owned
 */
export async function getPaymentStatusFacade(
  params: {
    sessionUser: SessionUser;
    attemptId: string;
  },
  ctx: RequestContext
): Promise<PaymentStatusOutput> {
  const start = performance.now();
  const container = getContainer();
  const accountService = container.accountsForUser(
    toUserId(params.sessionUser.id)
  );
  const userRepo = container.paymentAttemptsForUser(
    toUserId(params.sessionUser.id)
  );
  const {
    paymentAttemptServiceRepository: serviceRepo,
    onChainVerifier,
    clock,
  } = container;

  let billingAccount: Awaited<
    ReturnType<typeof getOrCreateBillingAccountForUser>
  >;
  try {
    billingAccount = await getOrCreateBillingAccountForUser(accountService, {
      userId: params.sessionUser.id,
      ...(params.sessionUser.walletAddress
        ? { walletAddress: params.sessionUser.walletAddress }
        : {}),
    });
  } catch (error) {
    // Check for FK constraint violation (user not found in DB)
    // Drizzle wraps Postgres errors - constraint name is in cause.message
    if (
      error &&
      typeof error === "object" &&
      "cause" in error &&
      error.cause instanceof Error &&
      error.cause.message.includes("billing_accounts_owner_user_id_users_id_fk")
    ) {
      throw new AuthUserNotFoundError(params.sessionUser.id);
    }
    throw error;
  }

  // Enrich context with business identifiers
  const enrichedCtx: RequestContext = {
    ...ctx,
    log: ctx.log.child({
      userId: params.sessionUser.id,
      billingAccountId: billingAccount.id,
    }),
  };

  const result = await getStatus(
    userRepo,
    serviceRepo,
    accountService,
    container.serviceAccountService,
    onChainVerifier,
    clock,
    enrichedCtx.log,
    {
      attemptId: params.attemptId,
      billingAccountId: billingAccount.id,
      defaultVirtualKeyId: billingAccount.defaultVirtualKeyId,
    },
    buildPostCreditFundingDeps(container, enrichedCtx.log)
  );

  // Log domain event (read operation)
  const readEvent: PaymentsStatusReadEvent = {
    event: "payments.status_read",
    routeId: ctx.routeId,
    reqId: ctx.reqId,
    billingAccountId: billingAccount.id,
    paymentIntentId: result.attemptId,
    status: result.clientStatus,
    durationMs: performance.now() - start,
  };
  enrichedCtx.log.info(readEvent, "payment status read");

  // Emit verified event when status poll discovers a CREDITED payment
  if (result.status === "CREDITED" && result.txHash) {
    const verifiedEvent: PaymentsVerifiedEvent = {
      event: "payments.verified",
      routeId: ctx.routeId,
      reqId: ctx.reqId,
      billingAccountId: billingAccount.id,
      paymentIntentId: result.attemptId,
      chainId: result.chainId,
      txHash: result.txHash,
      durationMs: performance.now() - start,
    };
    enrichedCtx.log.info(verifiedEvent, "payment verified and credited");
  }

  // Map port types (Date) to contract types (ISO string)
  return {
    attemptId: result.attemptId,
    status: result.clientStatus as
      | "PENDING_VERIFICATION"
      | "CONFIRMED"
      | "FAILED",
    txHash: result.txHash,
    amountUsdCents: result.amountUsdCents,
    errorCode: result.errorCode,
    createdAt: result.createdAt.toISOString(),
  };
}
