// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@core/accounts`
 * Purpose: Unit tests for accounts domain model.
 * Scope: Tests pure domain logic without external dependencies. Does not test adapters or infrastructure.
 * Invariants: Tests domain business rules and error conditions
 * Side-effects: none (unit tests only)
 * Notes: Tests Account interface and credit validation functions
 * Links: Tests @/core/accounts domain
 */

import {
  type Account,
  ensureHasCredits,
  hasSufficientCredits,
  InsufficientCreditsError,
} from "@cogni/node-core";
import { describe, expect, it } from "vitest";

describe("Account Domain Model", () => {
  const mockAccount: Account = {
    id: "test-account-123",
    balanceCredits: 100,
    displayName: "Test Account",
  };

  describe("hasSufficientCredits", () => {
    it("returns true when account has sufficient credits", () => {
      const result = hasSufficientCredits(mockAccount, 50);
      expect(result).toBe(true);
    });

    it("returns true when account has exactly the required credits", () => {
      const result = hasSufficientCredits(mockAccount, 100);
      expect(result).toBe(true);
    });

    it("returns false when account has insufficient credits", () => {
      const result = hasSufficientCredits(mockAccount, 150);
      expect(result).toBe(false);
    });

    it("handles zero balance correctly", () => {
      const zeroBalanceAccount: Account = {
        id: "zero-account",
        balanceCredits: 0,
      };

      expect(hasSufficientCredits(zeroBalanceAccount, 0)).toBe(true);
      expect(hasSufficientCredits(zeroBalanceAccount, 1)).toBe(false);
    });

    it("handles negative cost (should always return true)", () => {
      const result = hasSufficientCredits(mockAccount, -10);
      expect(result).toBe(true);
    });

    it("handles decimal precision correctly", () => {
      const decimalAccount: Account = {
        id: "decimal-account",
        balanceCredits: 10.5,
      };

      expect(hasSufficientCredits(decimalAccount, 10.4)).toBe(true);
      expect(hasSufficientCredits(decimalAccount, 10.5)).toBe(true);
      expect(hasSufficientCredits(decimalAccount, 10.6)).toBe(false);
    });
  });

  describe("ensureHasCredits", () => {
    it("does not throw when account has sufficient credits", () => {
      expect(() => {
        ensureHasCredits(mockAccount, 50);
      }).not.toThrow();
    });

    it("does not throw when account has exactly the required credits", () => {
      expect(() => {
        ensureHasCredits(mockAccount, 100);
      }).not.toThrow();
    });

    it("throws InsufficientCreditsError when account has insufficient credits", () => {
      expect(() => {
        ensureHasCredits(mockAccount, 150);
      }).toThrow(InsufficientCreditsError);
    });

    it("throws with correct error details", () => {
      try {
        ensureHasCredits(mockAccount, 150);
        expect.fail("Expected InsufficientCreditsError to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(InsufficientCreditsError);
        const creditError = error as InsufficientCreditsError;

        expect(creditError.accountId).toBe("test-account-123");
        expect(creditError.requiredCost).toBe(150);
        expect(creditError.availableBalance).toBe(100);
        expect(creditError.shortfall).toBe(50);
        expect(creditError.code).toBe("INSUFFICIENT_CREDITS");
        expect(creditError.message).toContain("test-account-123");
        expect(creditError.message).toContain("150");
        expect(creditError.message).toContain("100");
        expect(creditError.message).toContain("50");
      }
    });

    it("handles edge case of zero balance account", () => {
      const zeroAccount: Account = {
        id: "zero-balance",
        balanceCredits: 0,
      };

      expect(() => {
        ensureHasCredits(zeroAccount, 0);
      }).not.toThrow();

      expect(() => {
        ensureHasCredits(zeroAccount, 0.01);
      }).toThrow(InsufficientCreditsError);
    });

    it("handles minimal account (no optional fields)", () => {
      const minimalAccount: Account = {
        id: "minimal-account",
        balanceCredits: 25.75,
      };

      expect(() => {
        ensureHasCredits(minimalAccount, 25.75);
      }).not.toThrow();

      expect(() => {
        ensureHasCredits(minimalAccount, 26);
      }).toThrow(InsufficientCreditsError);
    });
  });
});
