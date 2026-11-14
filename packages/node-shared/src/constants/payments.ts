// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/constants/payments`
 * Purpose: Payment processing constants and reason strings.
 * Scope: Shared constants for payment features. Does not contain business logic.
 * Invariants: widget_payment is the only allowed reason for widget-funded credits.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/payments-usdc-verification-design
 * @public
 */

/** The singleton reason string for widget-funded credits. */
export const WIDGET_PAYMENT_REASON = "widget_payment" as const;
