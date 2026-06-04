// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/services/llmPricingPolicy`
 * Purpose: Policy layer for LLM pricing - reads env and delegates to pure math.
 * Scope: Single place that knows the current markup factor. Does not handle billing orchestration.
 * Invariants: All LLM billing flows call this; pure math stays in core/billing/pricing.ts.
 * Side-effects: none
 * Links: `src/core/billing/pricing.ts`, called by `completion.ts`
 * @public
 */

import { calculateLlmUserCharge } from "@cogni/node-core";
import { serverEnv } from "@/shared/env";

/**
 * Calculate LLM user charge using the configured markup factor.
 * This is the standard entry point for all LLM billing.
 *
 * @param providerCostUsd - Raw cost from LiteLLM
 * @returns { chargedCredits, userCostUsd }
 */
export function calculateDefaultLlmCharge(providerCostUsd: number): {
  chargedCredits: bigint;
  userCostUsd: number;
} {
  return calculateLlmUserCharge(
    providerCostUsd,
    serverEnv().USER_PRICE_MARKUP_FACTOR
  );
}
