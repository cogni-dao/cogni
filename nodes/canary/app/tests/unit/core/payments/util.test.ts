// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@core/payments/util`
 * Purpose: Unit tests for payment conversion utility functions.
 * Scope: Pure calculation testing. Does NOT test external dependencies or I/O.
 * Invariants: 1 USDC = 1,000,000 raw units (6 decimals); 1 USD = 100 cents; 1 cent = 10,000 raw units.
 * Side-effects: none
 * Notes: Verifies roundtrip conversions preserve values; tests boundary values and zero.
 * Links: core/payments/util
 * @public
 */

import { rawUsdcToUsdCents, usdCentsToRawUsdc } from "@cogni/node-core";
import { describe, expect, it } from "vitest";

describe("core/payments/util", () => {
  describe("usdCentsToRawUsdc", () => {
    it("should convert $1.00 (100 cents) to 1 USDC (1,000,000 raw)", () => {
      expect(usdCentsToRawUsdc(100)).toBe(1_000_000n);
    });

    it("should convert $10,000 (1,000,000 cents) to 10,000 USDC (10,000,000,000 raw)", () => {
      expect(usdCentsToRawUsdc(1_000_000)).toBe(10_000_000_000n);
    });

    it("should convert 1 cent to 10,000 raw units", () => {
      expect(usdCentsToRawUsdc(1)).toBe(10_000n);
    });

    it("should convert $5.00 (500 cents) to 5,000,000 raw units", () => {
      expect(usdCentsToRawUsdc(500)).toBe(5_000_000n);
    });

    it("should convert 0 cents to 0 raw units", () => {
      expect(usdCentsToRawUsdc(0)).toBe(0n);
    });

    it("should convert arbitrary value ($123.45 = 12345 cents)", () => {
      expect(usdCentsToRawUsdc(12345)).toBe(123_450_000n);
    });

    it("should handle conversion formula: cents * 10,000", () => {
      const cents = 250; // $2.50
      const expectedRaw = 2_500_000n;
      expect(usdCentsToRawUsdc(cents)).toBe(expectedRaw);
      expect(usdCentsToRawUsdc(cents)).toBe(BigInt(cents) * 10_000n);
    });
  });

  describe("rawUsdcToUsdCents", () => {
    it("should convert 1 USDC (1,000,000 raw) to $1.00 (100 cents)", () => {
      expect(rawUsdcToUsdCents(1_000_000n)).toBe(100);
    });

    it("should convert 10,000 USDC (10,000,000,000 raw) to $10,000 (1,000,000 cents)", () => {
      expect(rawUsdcToUsdCents(10_000_000_000n)).toBe(1_000_000);
    });

    it("should convert 10,000 raw units to 1 cent", () => {
      expect(rawUsdcToUsdCents(10_000n)).toBe(1);
    });

    it("should convert 5,000,000 raw units to $5.00 (500 cents)", () => {
      expect(rawUsdcToUsdCents(5_000_000n)).toBe(500);
    });

    it("should convert 0 raw units to 0 cents", () => {
      expect(rawUsdcToUsdCents(0n)).toBe(0);
    });

    it("should convert arbitrary value (123,450,000 raw = 12345 cents = $123.45)", () => {
      expect(rawUsdcToUsdCents(123_450_000n)).toBe(12345);
    });

    it("should handle conversion formula: raw / 10,000", () => {
      const raw = 2_500_000n; // $2.50
      const expectedCents = 250;
      expect(rawUsdcToUsdCents(raw)).toBe(expectedCents);
      expect(rawUsdcToUsdCents(raw)).toBe(Number(raw / 10_000n));
    });
  });

  describe("Roundtrip conversions", () => {
    describe("Forward roundtrip: cents → raw → cents", () => {
      it("should preserve 100 cents ($1.00 minimum)", () => {
        const cents = 100;
        const raw = usdCentsToRawUsdc(cents);
        const result = rawUsdcToUsdCents(raw);
        expect(result).toBe(cents);
      });

      it("should preserve 1,000,000 cents ($10,000 maximum)", () => {
        const cents = 1_000_000;
        const raw = usdCentsToRawUsdc(cents);
        const result = rawUsdcToUsdCents(raw);
        expect(result).toBe(cents);
      });

      it("should preserve 1 cent (minimum granularity)", () => {
        const cents = 1;
        const raw = usdCentsToRawUsdc(cents);
        const result = rawUsdcToUsdCents(raw);
        expect(result).toBe(cents);
      });

      it("should preserve 500 cents ($5.00 typical)", () => {
        const cents = 500;
        const raw = usdCentsToRawUsdc(cents);
        const result = rawUsdcToUsdCents(raw);
        expect(result).toBe(cents);
      });

      it("should preserve 12345 cents ($123.45 arbitrary)", () => {
        const cents = 12345;
        const raw = usdCentsToRawUsdc(cents);
        const result = rawUsdcToUsdCents(raw);
        expect(result).toBe(cents);
      });
    });

    describe("Backward roundtrip: raw → cents → raw", () => {
      it("should preserve 1,000,000 raw (1 USDC = $1.00 minimum)", () => {
        const raw = 1_000_000n;
        const cents = rawUsdcToUsdCents(raw);
        const result = usdCentsToRawUsdc(cents);
        expect(result).toBe(raw);
      });

      it("should preserve 10,000,000,000 raw (10,000 USDC = $10,000 maximum)", () => {
        const raw = 10_000_000_000n;
        const cents = rawUsdcToUsdCents(raw);
        const result = usdCentsToRawUsdc(cents);
        expect(result).toBe(raw);
      });

      it("should preserve 10,000 raw (1 cent minimum granularity)", () => {
        const raw = 10_000n;
        const cents = rawUsdcToUsdCents(raw);
        const result = usdCentsToRawUsdc(cents);
        expect(result).toBe(raw);
      });

      it("should preserve 5,000,000 raw (500 cents = $5.00 typical)", () => {
        const raw = 5_000_000n;
        const cents = rawUsdcToUsdCents(raw);
        const result = usdCentsToRawUsdc(cents);
        expect(result).toBe(raw);
      });

      it("should preserve 123,450,000 raw (12345 cents = $123.45 arbitrary)", () => {
        const raw = 123_450_000n;
        const cents = rawUsdcToUsdCents(raw);
        const result = usdCentsToRawUsdc(cents);
        expect(result).toBe(raw);
      });
    });

    describe("No precision loss verification", () => {
      it("should maintain precision for all valid payment amounts", () => {
        const testCents = [
          1, // minimum granularity
          100, // minimum payment
          500, // typical
          12345, // arbitrary
          1_000_000, // maximum
        ];

        testCents.forEach((cents) => {
          const raw = usdCentsToRawUsdc(cents);
          const roundtrip = rawUsdcToUsdCents(raw);
          expect(roundtrip).toBe(cents);
        });
      });

      it("should maintain precision for all valid raw amounts", () => {
        const testRaw = [
          10_000n, // 1 cent minimum
          1_000_000n, // $1 minimum payment
          5_000_000n, // $5 typical
          123_450_000n, // $123.45 arbitrary
          10_000_000_000n, // $10,000 maximum
        ];

        testRaw.forEach((raw) => {
          const cents = rawUsdcToUsdCents(raw);
          const roundtrip = usdCentsToRawUsdc(cents);
          expect(roundtrip).toBe(raw);
        });
      });
    });
  });
});
