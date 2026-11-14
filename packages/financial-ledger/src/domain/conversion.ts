// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/financial-ledger/domain/conversion`
 * Purpose: USDC-to-credit conversion and UUID-to-bigint utilities.
 * Scope: Pure math — no I/O, no dependencies. Does not perform floating-point operations.
 * Invariants:
 *   - ALL_MATH_BIGINT: All monetary calculations use bigint
 *   - Integer math only: credits = micro_usdc * 10 (no floats)
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/financial-ledger-tigerbeetle (Cross-Ledger Transfers)
 * @public
 */

/**
 * Credits per USD (10 million credits = 1 USD).
 * Matches the existing protocol constant in billing.
 */
export const CREDITS_PER_USD = 10_000_000n;

/** USDC scale factor (6 decimals → 1 USDC = 1,000,000 micro-USDC). */
export const USDC_SCALE = 1_000_000n;

/**
 * Convert micro-USDC to credits.
 * Formula: credits = micro_usdc * CREDITS_PER_USD / USDC_SCALE = micro_usdc * 10
 * Pure integer math, no floats.
 */
export function microUsdcToCredits(microUsdc: bigint): bigint {
  return microUsdc * 10n;
}

/**
 * Convert a UUID string to a bigint (u128).
 * Used for TigerBeetle transfer/account IDs and user_data_128 fields.
 * Maps Postgres UUIDs to TigerBeetle's native u128 format.
 */
export function uuidToBigInt(uuid: string): bigint {
  const hex = uuid.replace(/-/g, "");
  return BigInt(`0x${hex}`);
}
