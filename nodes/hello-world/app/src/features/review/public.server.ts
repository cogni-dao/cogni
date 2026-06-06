// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/review/public.server`
 * Purpose: Server-side barrel exports for the review feature.
 * Scope: Re-exports from services. Does not contain business logic.
 * Invariants: Only app-layer facades import this barrel. Never import services/* directly from outside.
 * Side-effects: none
 * Links: task.0153
 * @public
 */

export type { ReviewHandlerDeps } from "./services/review-handler";
export { handlePrReview } from "./services/review-handler";
