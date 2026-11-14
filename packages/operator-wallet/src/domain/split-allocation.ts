// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet/domain/split-allocation`
 * Purpose: Pure split allocation math for 0xSplits V2 revenue distribution.
 * Scope: Derives operator/DAO allocation ratios from billing economics using bigint-only arithmetic. Does not perform I/O, access env, or use floating-point math.
 * Invariants: Allocations sum to SPLIT_TOTAL_ALLOCATION; operator share strictly between 0 and 1; all inputs are scaled bigint (PPM).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/operator-wallet-custody-boundary, scripts/deploy-split.ts
 * @public
 */

/**
 * Parts-per-million scale factor (1_000_000 = 100%).
 * Used as the canonical fixed-point scale for all split allocation inputs.
 */
export const PPM = 1_000_000n;

/**
 * OpenRouter crypto top-up provider fee in PPM (50_000 = 5%).
 * Source: spike.0090 — validated on Base mainnet.
 */
export const OPENROUTER_CRYPTO_FEE_PPM = 50_000n;

/**
 * Minimum inbound USDC payment in dollars.
 * OpenRouter minimum charge is $1.00 (+ 5% fee = $1.05 USDC).
 * Set to $2.00 to ensure a clean user-facing amount above the provider minimum.
 */
export const MINIMUM_PAYMENT_USD = 2;

/**
 * 0xSplits V2 total allocation denominator.
 * 1e6 gives 0.0001% precision — matches spike.0090 validated config.
 */
export const SPLIT_TOTAL_ALLOCATION = 1_000_000n;

/**
 * Convert a decimal number to PPM bigint at the system boundary.
 * Use this at env/config parsing time — never inside core math.
 *
 * @param value - Decimal value (e.g., 2.0 for 2x markup, 0.75 for 75%)
 * @returns Scaled bigint in PPM (e.g., 2_000_000n, 750_000n)
 */
export function numberToPpm(value: number): bigint {
  return BigInt(Math.round(value * 1_000_000));
}

/**
 * Derive operator/DAO split allocations from billing economics.
 * All inputs are scaled bigint in PPM (1_000_000 = 100%).
 *
 * Formula (conceptual):
 *   operatorShare = (1 + revenueShare) / (markup × (1 − providerFee))
 *
 * In PPM arithmetic:
 *   numerator   = (PPM + revenueSharePpm) × PPM
 *   denominator = markupPpm × (PPM − providerFeePpm)
 *   operatorAllocation = numerator / denominator  (with largest-remainder rounding)
 *
 * With defaults (markup=2_000_000, revenueShare=750_000, fee=50_000):
 *   (1_750_000 × 1_000_000) / (2_000_000 × 950_000) = 1_750_000_000_000 / 1_900_000_000_000
 *   → 921_052 with remainder 1_200_000_000_000 (> half denominator) → rounds up to 921_053
 *   DAO gets the remainder: 78_947 / 1_000_000 (7.9%)
 *
 * Uses largest-remainder (Hamilton's method) to guarantee allocations sum exactly
 * to SPLIT_TOTAL_ALLOCATION with deterministic, fair rounding.
 */
export function calculateSplitAllocations(
  markupPpm: bigint,
  revenueSharePpm: bigint,
  providerFeePpm: bigint = OPENROUTER_CRYPTO_FEE_PPM
): { operatorAllocation: bigint; treasuryAllocation: bigint } {
  // Guard: denominator must be positive
  if (markupPpm <= 0n) {
    throw new Error(`Invalid split: markupPpm=${markupPpm} must be > 0`);
  }
  const feeComplement = PPM - providerFeePpm;
  if (feeComplement <= 0n) {
    throw new Error(
      `Invalid split: providerFeePpm=${providerFeePpm} must be < ${PPM}`
    );
  }

  // Pure bigint arithmetic — no floating point
  const numerator = (PPM + revenueSharePpm) * SPLIT_TOTAL_ALLOCATION;
  const denominator = (markupPpm * feeComplement) / PPM;

  if (denominator <= 0n) {
    throw new Error(
      `Invalid split: computed denominator=${denominator} must be > 0. ` +
        `Check markupPpm=${markupPpm}, providerFeePpm=${providerFeePpm}`
    );
  }

  // Floor division + remainder for largest-remainder rounding
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;

  // Largest-remainder: round up if remainder >= half the denominator
  const operatorAllocation =
    2n * remainder >= denominator ? quotient + 1n : quotient;

  // Validate result is in valid range (0 < operator < total)
  if (
    operatorAllocation <= 0n ||
    operatorAllocation >= SPLIT_TOTAL_ALLOCATION
  ) {
    throw new Error(
      `Invalid split: operatorAllocation=${operatorAllocation} (must be 0 < x < ${SPLIT_TOTAL_ALLOCATION}). ` +
        `Check markupPpm=${markupPpm}, revenueSharePpm=${revenueSharePpm}, providerFeePpm=${providerFeePpm}`
    );
  }

  return {
    operatorAllocation,
    treasuryAllocation: SPLIT_TOTAL_ALLOCATION - operatorAllocation,
  };
}
