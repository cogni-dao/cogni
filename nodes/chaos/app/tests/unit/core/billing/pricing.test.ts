// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/core/billing/pricing`
 * Purpose: Unit tests for pricing helpers and revenue share math.
 * Scope: Verifies calculateLlmUserCharge, calculateRevenueShareBonus, and CREDITS_PER_USD constant. Does not test policy layer.
 * Invariants: Single ceil at the end; markup applied before rounding.
 * Side-effects: none
 * Links: `src/core/billing/pricing.ts`
 */

import {
  CREDITS_PER_USD,
  calculateLlmUserCharge,
  calculateOpenRouterTopUp,
  calculateRevenueShareBonus,
  isMarginPreserved,
  usdCentsToCredits,
  usdToCredits,
} from "@cogni/node-core";
import { describe, expect, it } from "vitest";

describe("Pricing Logic", () => {
  describe("CREDITS_PER_USD constant", () => {
    it("is 10 million (1 credit = $0.0000001)", () => {
      expect(CREDITS_PER_USD).toBe(10_000_000);
    });
  });

  describe("usdToCredits", () => {
    it("converts USD to credits using CREDITS_PER_USD constant", () => {
      // $1.00 = 10,000,000 credits
      expect(usdToCredits(1.0)).toBe(10_000_000n);
      // $0.0000001 = 1 credit
      expect(usdToCredits(0.0000001)).toBe(1n);
    });

    it("rounds up fractional credits (ceil)", () => {
      // $0.00000015 = 1.5 credits → 2 credits
      expect(usdToCredits(0.00000015)).toBe(2n);
      // $0.00000011 = 1.1 credits → 2 credits
      expect(usdToCredits(0.00000011)).toBe(2n);
    });

    it("handles zero cost", () => {
      expect(usdToCredits(0)).toBe(0n);
    });
  });

  describe("usdCentsToCredits", () => {
    it("converts cents to credits using integer math (ceil)", () => {
      // 100 cents ($1.00) = ceil(100 * 10_000_000 / 100) = 10_000_000 credits
      expect(usdCentsToCredits(100)).toBe(10_000_000n);
      // 1 cent ($0.01) = ceil(1 * 10_000_000 / 100) = 100_000 credits
      expect(usdCentsToCredits(1)).toBe(100_000n);
      // 1100 cents ($11.00) = ceil(1100 * 10_000_000 / 100) = 110_000_000 credits
      expect(usdCentsToCredits(1100)).toBe(110_000_000n);
    });

    it("handles zero cents", () => {
      expect(usdCentsToCredits(0)).toBe(0n);
    });

    it("throws on negative input", () => {
      expect(() => usdCentsToCredits(-1)).toThrow(
        "amountUsdCents must be non-negative"
      );
    });

    it("accepts bigint input", () => {
      expect(usdCentsToCredits(100n)).toBe(10_000_000n);
    });
  });

  describe("calculateLlmUserCharge", () => {
    const MARKUP = 2.0; // 100% markup

    it("applies markup then converts to credits", () => {
      // Provider cost: $0.0006261
      // User cost: $0.0006261 * 2.0 = $0.0012522
      // Credits: ceil(0.0012522 * 10_000_000) = ceil(12522) = 12522
      const result = calculateLlmUserCharge(0.0006261, MARKUP);
      expect(result.userCostUsd).toBeCloseTo(0.0012522, 10);
      expect(result.chargedCredits).toBe(12522n);
    });

    it("handles tiny costs with precision", () => {
      // Provider cost: $0.0001
      // User cost: $0.0001 * 2.0 = $0.0002
      // Credits: ceil(0.0002 * 10_000_000) = ceil(2000) = 2000
      const result = calculateLlmUserCharge(0.0001, MARKUP);
      expect(result.userCostUsd).toBeCloseTo(0.0002, 10);
      expect(result.chargedCredits).toBe(2000n);
    });

    it("handles larger costs", () => {
      // Provider cost: $1.00
      // User cost: $1.00 * 2.0 = $2.00
      // Credits: ceil(2.00 * 10_000_000) = 20_000_000
      const result = calculateLlmUserCharge(1.0, MARKUP);
      expect(result.userCostUsd).toBe(2.0);
      expect(result.chargedCredits).toBe(20_000_000n);
    });

    it("rounds up when needed (single ceil)", () => {
      // Provider cost: $0.00000001
      // User cost: $0.00000001 * 2.0 = $0.00000002
      // Credits: ceil(0.00000002 * 10_000_000) = ceil(0.2) = 1
      const result = calculateLlmUserCharge(0.00000001, MARKUP);
      expect(result.chargedCredits).toBe(1n);
    });

    it("handles zero cost", () => {
      const result = calculateLlmUserCharge(0, MARKUP);
      expect(result.userCostUsd).toBe(0);
      expect(result.chargedCredits).toBe(0n);
    });

    it("works with different markup factors", () => {
      // 1.5x markup
      const result = calculateLlmUserCharge(0.001, 1.5);
      expect(result.userCostUsd).toBeCloseTo(0.0015, 10);
      // Credits: ceil(0.0015 * 10_000_000) = 15000
      expect(result.chargedCredits).toBe(15000n);
    });
  });

  describe("calculateOpenRouterTopUp", () => {
    // Default constants: markup=2.0, revenueShare=0.75, cryptoFee=0.05
    const MARKUP = 2.0;
    const REVENUE_SHARE = 0.75;
    const CRYPTO_FEE = 0.05;

    it("computes top-up from $1.00 purchase with default constants", () => {
      // topUp = (100/100) × (1 + 0.75) / (2.0 × 0.95) = 1.75 / 1.90 ≈ $0.9211
      const topUp = calculateOpenRouterTopUp(
        100,
        MARKUP,
        REVENUE_SHARE,
        CRYPTO_FEE
      );
      expect(topUp).toBeCloseTo(0.9211, 3);
    });

    it("scales linearly with payment amount", () => {
      const topUp1 = calculateOpenRouterTopUp(
        100,
        MARKUP,
        REVENUE_SHARE,
        CRYPTO_FEE
      );
      const topUp10 = calculateOpenRouterTopUp(
        1000,
        MARKUP,
        REVENUE_SHARE,
        CRYPTO_FEE
      );
      expect(topUp10).toBeCloseTo(topUp1 * 10, 8);
    });

    it("returns 0 for zero payment", () => {
      expect(
        calculateOpenRouterTopUp(0, MARKUP, REVENUE_SHARE, CRYPTO_FEE)
      ).toBe(0);
    });

    it("returns 0 when denominator is zero or negative", () => {
      // cryptoFee=1.0 → denominator = markup × 0 = 0
      expect(calculateOpenRouterTopUp(100, MARKUP, REVENUE_SHARE, 1.0)).toBe(0);
    });

    it("top-up is less than user payment (margin preserved)", () => {
      const topUp = calculateOpenRouterTopUp(
        100,
        MARKUP,
        REVENUE_SHARE,
        CRYPTO_FEE
      );
      expect(topUp).toBeLessThan(1.0); // $1.00 payment → < $1.00 top-up
    });
  });

  describe("isMarginPreserved", () => {
    it("returns true with default constants (2.0, 0.75, 0.05)", () => {
      // 2.0 × 0.95 = 1.90 > 1.75 = 1 + 0.75
      expect(isMarginPreserved(2.0, 0.75, 0.05)).toBe(true);
    });

    it("returns false when markup too low", () => {
      // 1.5 × 0.95 = 1.425 < 1.75
      expect(isMarginPreserved(1.5, 0.75, 0.05)).toBe(false);
    });

    it("returns false when fee too high", () => {
      // 2.0 × 0.10 = 0.2 < 1.75
      expect(isMarginPreserved(2.0, 0.75, 0.9)).toBe(false);
    });

    it("returns true with no revenue share", () => {
      // 2.0 × 0.95 = 1.90 > 1.0
      expect(isMarginPreserved(2.0, 0, 0.05)).toBe(true);
    });
  });

  describe("calculateRevenueShareBonus", () => {
    it("computes 75% bonus using scaled integer math", () => {
      // 100,000,000 credits * 0.75 = 75,000,000
      expect(calculateRevenueShareBonus(100_000_000n, 0.75)).toBe(75_000_000n);
    });

    it("returns 0n when revenueShare is 0", () => {
      expect(calculateRevenueShareBonus(100_000_000n, 0)).toBe(0n);
    });

    it("returns 0n when revenueShare is negative", () => {
      expect(calculateRevenueShareBonus(100_000_000n, -0.5)).toBe(0n);
    });

    it("computes 100% bonus", () => {
      expect(calculateRevenueShareBonus(100_000_000n, 1.0)).toBe(100_000_000n);
    });

    it("floors fractional credits (no rounding up)", () => {
      // 3 credits * 0.75 = 2.25 → floor = 2
      expect(calculateRevenueShareBonus(3n, 0.75)).toBe(2n);
    });

    it("handles small credit amounts", () => {
      // 1 credit * 0.75 = 0.75 → floor = 0
      expect(calculateRevenueShareBonus(1n, 0.75)).toBe(0n);
    });

    it("handles typical purchase amounts", () => {
      // $10 purchase = 100,000,000 credits → 75% = 75,000,000
      expect(calculateRevenueShareBonus(100_000_000n, 0.75)).toBe(75_000_000n);
      // $100 purchase = 1,000,000,000 credits → 75% = 750,000,000
      expect(calculateRevenueShareBonus(1_000_000_000n, 0.75)).toBe(
        750_000_000n
      );
    });
  });
});
