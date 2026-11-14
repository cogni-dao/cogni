// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/utils/money`
 * Purpose: Money formatting and parsing utilities.
 * Scope: Pure utility functions for converting dollar strings to cents without float math. Does not handle UI, API calls, or payment logic.
 * Invariants: No floating-point arithmetic; all parsing via string manipulation; validates range and format.
 * Side-effects: none
 * Notes: Prevents precision errors from float math. Shared by UI and feature layers.
 * Links: https://node-template.cognidao.org/knowledge/payments-usdc-verification-design
 * @public
 */

import { MAX_PAYMENT_CENTS, MIN_PAYMENT_CENTS } from "@cogni/node-core";

const MIN_AMOUNT_USD = MIN_PAYMENT_CENTS / 100;
const MAX_AMOUNT_USD = MAX_PAYMENT_CENTS / 100;

/**
 * Validate amount string while typing.
 * Allows: empty, digits, single decimal with 0-2 places.
 * Rejects: thousands separators, multiple decimals, >2 decimal places.
 */
export function isValidAmountInput(input: string): boolean {
  if (input === "") return true; // Allow empty while typing
  if (/[,\s]/.test(input)) return false; // Reject thousands separators
  return /^\d+(\.\d{0,2})?$/.test(input);
}

/**
 * Parse dollar string to cents (integer). No float math.
 * Returns null if invalid or out of range.
 * Handles trailing dot: "10." → 1000 cents
 *
 * @example
 * parseDollarsToCents("10.50") → 1050
 * parseDollarsToCents("10.") → 1000
 * parseDollarsToCents("2") → 200
 * parseDollarsToCents("1.99") → null (below minimum)
 * parseDollarsToCents("") → null
 */
export function parseDollarsToCents(input: string): number | null {
  if (input === "") return null;

  // Allow trailing dot or 1-2 decimal places
  if (!/^\d+\.?\d{0,2}$/.test(input)) return null;

  const parts = input.split(".");
  const dollars = parts[0] ?? "0";
  const cents = parts[1] ?? "";
  const totalCents =
    Number.parseInt(dollars, 10) * 100 +
    Number.parseInt(cents.padEnd(2, "0"), 10);

  // Clamp to valid range
  if (totalCents < MIN_AMOUNT_USD * 100) return null;
  if (totalCents > MAX_AMOUNT_USD * 100) return null;
  if (!Number.isFinite(totalCents)) return null; // Safety for huge inputs

  return totalCents;
}

/**
 * Format cents to dollar string for display.
 * @example
 * formatCentsToDollars(1050) → "10.50"
 * formatCentsToDollars(100) → "1.00"
 */
export function formatCentsToDollars(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const remainingCents = cents % 100;
  return `${dollars}.${remainingCents.toString().padStart(2, "0")}`;
}

export { MIN_AMOUNT_USD, MAX_AMOUNT_USD };
