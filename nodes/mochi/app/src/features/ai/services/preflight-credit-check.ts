// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/services/preflight-credit-check`
 * Purpose: Pre-flight credit validation using conservative upper-bound estimate.
 * Scope: Estimate cost, check balance, throw if insufficient. Does NOT perform billing or LLM calls.
 * Invariants:
 *   - CREDIT_ESTIMATE_UPPER_BOUND: Uses ESTIMATED_USD_PER_1K_TOKENS (cannot underestimate)
 *   - Free models return immediately (0n cost)
 *   - Uses same USD->credits pipeline as post-call billing
 *   - Throws InsufficientCreditsPortError if balance insufficient
 * Side-effects: IO (reads balance via AccountService)
 * Notes: Per COMPLETION_REFACTOR_PLAN.md P2 extraction
 * Links: completion.ts, ports/account.port.ts, core/billing/pricing.ts
 * @public
 */

import {
  ESTIMATED_USD_PER_1K_TOKENS,
  estimateTotalTokens,
  type Message,
} from "@cogni/node-core";
import type { AccountService } from "@/ports";
import { InsufficientCreditsPortError } from "@/ports";
import { isModelFree } from "@/shared/ai/model-catalog.server";
import { calculateDefaultLlmCharge } from "./llmPricingPolicy";

/**
 * Estimate cost in credits for pre-flight gating.
 *
 * Uses ESTIMATED_USD_PER_1K_TOKENS as upper-bound estimate.
 * Post-call billing uses actual LiteLLM cost; these may differ (expected).
 *
 * Invariants:
 * - Free models MUST return 0n
 * - Paid models return >0n
 * - Uses same USD→credits pipeline as post-call (calculateDefaultLlmCharge)
 * - Only difference: estimated vs actual USD input
 */
async function estimateCostCredits(
  model: string,
  estimatedTotalTokens: number
): Promise<bigint> {
  if (await isModelFree(model)) {
    return 0n;
  }

  // Preflight uses conservative upper-bound estimate
  const estimatedCostUsd =
    (estimatedTotalTokens / 1000) * ESTIMATED_USD_PER_1K_TOKENS;

  // Same pipeline as post-call: markup + ceil via calculateDefaultLlmCharge
  const { chargedCredits } = calculateDefaultLlmCharge(estimatedCostUsd);
  return chargedCredits;
}

/**
 * Validate that billing account has sufficient credits for estimated LLM cost.
 *
 * Uses conservative upper-bound estimate (ESTIMATED_USD_PER_1K_TOKENS).
 * Free models pass immediately with 0n cost estimate.
 *
 * @param billingAccountId - Account to check
 * @param estimatedTokensUpperBound - Upper-bound token estimate from message preparation
 * @param model - Model identifier (for free model check)
 * @param accountService - Account service port for balance lookup
 * @throws InsufficientCreditsPortError if balance < estimated cost
 */
export async function validateCreditsUpperBound(
  billingAccountId: string,
  estimatedTokensUpperBound: number,
  model: string,
  accountService: AccountService
): Promise<void> {
  const estimatedUserPriceCredits = await estimateCostCredits(
    model,
    estimatedTokensUpperBound
  );

  const currentBalance = await accountService.getBalance(billingAccountId);

  if (currentBalance < Number(estimatedUserPriceCredits)) {
    throw new InsufficientCreditsPortError(
      billingAccountId,
      Number(estimatedUserPriceCredits),
      currentBalance
    );
  }
}

/**
 * Parameters for facade-level preflight credit check.
 */
export interface PreflightCreditCheckParams {
  readonly billingAccountId: string;
  readonly messages: Message[];
  readonly model: string;
  readonly accountService: AccountService;
}

/**
 * Facade-level preflight credit check.
 *
 * Best-effort estimate from user/assistant messages + fixed buffer.
 * Per GRAPH_OWNS_MESSAGES: does not assume any system prompt — graphs own their prompts.
 * This is a rough pre-check, not a guarantee. Post-call metering is source of truth.
 *
 * @throws InsufficientCreditsPortError if balance < estimated cost
 */
export async function preflightCreditCheck(
  params: PreflightCreditCheckParams
): Promise<void> {
  const { billingAccountId, messages, model, accountService } = params;

  // Estimate from user/assistant messages only + buffer for OpenClaw graph overhead
  // OpenClaw uses ~20k tokens average for system prompts, tool use, and reasoning
  const GRAPH_OVERHEAD_BUFFER = 10000;
  const baseTokens = estimateTotalTokens(messages);
  const estimatedTokensUpperBound = baseTokens + GRAPH_OVERHEAD_BUFFER;

  await validateCreditsUpperBound(
    billingAccountId,
    estimatedTokensUpperBound,
    model,
    accountService
  );
}
