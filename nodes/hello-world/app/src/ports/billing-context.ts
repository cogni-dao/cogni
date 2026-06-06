// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/billing-context`
 * Purpose: App-layer billing types for graph execution — billing resolution, credit checks.
 * Scope: Defines BillingContext, BillingResolver, and PreflightCreditCheckFn. Does not appear on any shared contract in @cogni/graph-execution-core.
 * Invariants:
 *   - APP_LAYER_ONLY: These types never appear in @cogni/graph-execution-core
 *   - BILLING_RESOLVED_AT_LAUNCHER: Each launcher (chat, schedule, webhook) resolves billing once before execution
 * Side-effects: none (interface only)
 * Links: docs/spec/unified-graph-launch.md
 * @public
 */

import type { Message } from "@cogni/ai-core";

/** Billing credentials resolved per-run for adapters and decorators. */
export interface BillingContext {
  readonly billingAccountId: string;
  readonly virtualKeyId: string;
}

/**
 * Resolves billing credentials from launcher-specific input.
 * Each launcher type (chat, schedule, webhook) builds its own resolver
 * from session/account/tenant context.
 */
export interface BillingResolver {
  resolve(actorUserId: string): BillingContext;
}

/**
 * Preflight credit check gate for graph execution.
 *
 * Called before execution to verify sufficient credits.
 * The launcher resolves billingAccountId and passes it in.
 *
 * @throws InsufficientCreditsPortError if balance < estimated cost
 */
export type PreflightCreditCheckFn = (
  billingAccountId: string,
  model: string,
  messages: readonly Message[]
) => Promise<void>;
