// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/public`
 * Purpose: Public API surface for payment feature - barrel export for stable feature boundaries.
 * Scope: Re-exports public types and functions; does not implement logic.
 * Invariants: All public exports must be stable; breaking changes require new feature version.
 * Side-effects: none
 * Notes: Feature consumers should only import from this file, never from internal modules.
 * Links: Part of hexagonal architecture boundary enforcement
 * @public
 */

export type { PaymentFlowPhase, PaymentFlowState } from "@cogni/node-core";
export { creditsToUsd, usdCentsToCredits } from "@cogni/node-core";
export type { PaymentsFeatureError } from "./errors";
export {
  AuthUserNotFoundError,
  isPaymentsFeatureError,
  mapPaymentPortErrorToFeature,
  PaymentNotFoundError,
} from "./errors";
export {
  type UseCreditsSummaryOptions,
  useCreditsSummary,
} from "./hooks/useCreditsSummary";
export { usePaymentFlow } from "./hooks/usePaymentFlow";
