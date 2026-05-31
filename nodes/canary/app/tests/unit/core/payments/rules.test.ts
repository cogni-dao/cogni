// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@core/payments/rules`
 * Purpose: Unit tests for payment state machine and validation business rules.
 * Scope: Pure business logic testing. Does NOT test external dependencies or I/O.
 * Invariants: State transitions follow spec; amount bounds enforced; TTLs calculated correctly.
 * Side-effects: none
 * Notes: Uses FakeClock for deterministic time testing; uses payment builders for test data.
 * Links: core/payments/rules
 * @public
 */

import type { PaymentAttemptStatus } from "@cogni/node-core";
import {
  isIntentExpired,
  isTerminalState,
  isValidPaymentAmount,
  isValidTransition,
  isVerificationTimedOut,
  MAX_PAYMENT_CENTS,
  MIN_PAYMENT_CENTS,
  PAYMENT_INTENT_TTL_MS,
  PENDING_UNVERIFIED_TTL_MS,
  toClientVisibleStatus,
} from "@cogni/node-core";
import {
  createIntentAttempt,
  createPaymentAttempt,
  FakeClock,
} from "@tests/_fakes";
import { describe, expect, it } from "vitest";

describe("core/payments/rules", () => {
  describe("isValidTransition", () => {
    describe("Valid transitions from CREATED_INTENT", () => {
      it("should allow CREATED_INTENT → PENDING_UNVERIFIED (submit txHash)", () => {
        expect(isValidTransition("CREATED_INTENT", "PENDING_UNVERIFIED")).toBe(
          true
        );
      });

      it("should allow CREATED_INTENT → FAILED (intent expiration)", () => {
        expect(isValidTransition("CREATED_INTENT", "FAILED")).toBe(true);
      });

      it("should reject CREATED_INTENT → CREDITED (skip verification)", () => {
        expect(isValidTransition("CREATED_INTENT", "CREDITED")).toBe(false);
      });

      it("should reject CREATED_INTENT → REJECTED (invalid)", () => {
        expect(isValidTransition("CREATED_INTENT", "REJECTED")).toBe(false);
      });
    });

    describe("Valid transitions from PENDING_UNVERIFIED", () => {
      it("should allow PENDING_UNVERIFIED → CREDITED (verification success)", () => {
        expect(isValidTransition("PENDING_UNVERIFIED", "CREDITED")).toBe(true);
      });

      it("should allow PENDING_UNVERIFIED → REJECTED (verification failure)", () => {
        expect(isValidTransition("PENDING_UNVERIFIED", "REJECTED")).toBe(true);
      });

      it("should allow PENDING_UNVERIFIED → FAILED (tx reverted or timeout)", () => {
        expect(isValidTransition("PENDING_UNVERIFIED", "FAILED")).toBe(true);
      });

      it("should reject PENDING_UNVERIFIED → CREATED_INTENT (backward transition)", () => {
        expect(isValidTransition("PENDING_UNVERIFIED", "CREATED_INTENT")).toBe(
          false
        );
      });
    });

    describe("Terminal states prevent all transitions", () => {
      const terminalStates: PaymentAttemptStatus[] = [
        "CREDITED",
        "REJECTED",
        "FAILED",
      ];
      const allStates: PaymentAttemptStatus[] = [
        "CREATED_INTENT",
        "PENDING_UNVERIFIED",
        "CREDITED",
        "REJECTED",
        "FAILED",
      ];

      terminalStates.forEach((fromState) => {
        describe(`from ${fromState}`, () => {
          allStates.forEach((toState) => {
            if (fromState !== toState) {
              it(`should reject ${fromState} → ${toState}`, () => {
                expect(isValidTransition(fromState, toState)).toBe(false);
              });
            }
          });
        });
      });
    });

    describe("Self-transitions are always invalid", () => {
      const allStates: PaymentAttemptStatus[] = [
        "CREATED_INTENT",
        "PENDING_UNVERIFIED",
        "CREDITED",
        "REJECTED",
        "FAILED",
      ];

      allStates.forEach((state) => {
        it(`should reject ${state} → ${state}`, () => {
          expect(isValidTransition(state, state)).toBe(false);
        });
      });
    });
  });

  describe("isTerminalState", () => {
    it("should return true for CREDITED", () => {
      expect(isTerminalState("CREDITED")).toBe(true);
    });

    it("should return true for REJECTED", () => {
      expect(isTerminalState("REJECTED")).toBe(true);
    });

    it("should return true for FAILED", () => {
      expect(isTerminalState("FAILED")).toBe(true);
    });

    it("should return false for CREATED_INTENT", () => {
      expect(isTerminalState("CREATED_INTENT")).toBe(false);
    });

    it("should return false for PENDING_UNVERIFIED", () => {
      expect(isTerminalState("PENDING_UNVERIFIED")).toBe(false);
    });
  });

  describe("toClientVisibleStatus", () => {
    describe("Maps CREATED_INTENT and PENDING_UNVERIFIED to PENDING_VERIFICATION", () => {
      it("should map CREATED_INTENT → PENDING_VERIFICATION", () => {
        expect(toClientVisibleStatus("CREATED_INTENT")).toBe(
          "PENDING_VERIFICATION"
        );
      });

      it("should map PENDING_UNVERIFIED → PENDING_VERIFICATION", () => {
        expect(toClientVisibleStatus("PENDING_UNVERIFIED")).toBe(
          "PENDING_VERIFICATION"
        );
      });
    });

    describe("Maps CREDITED to CONFIRMED", () => {
      it("should map CREDITED → CONFIRMED", () => {
        expect(toClientVisibleStatus("CREDITED")).toBe("CONFIRMED");
      });
    });

    describe("Maps REJECTED and FAILED to FAILED", () => {
      it("should map REJECTED → FAILED", () => {
        expect(toClientVisibleStatus("REJECTED")).toBe("FAILED");
      });

      it("should map FAILED → FAILED", () => {
        expect(toClientVisibleStatus("FAILED")).toBe("FAILED");
      });
    });
  });

  describe("isValidPaymentAmount", () => {
    describe("Accepts valid amounts within bounds", () => {
      it("should accept minimum valid amount (200 cents = $2.00)", () => {
        expect(isValidPaymentAmount(MIN_PAYMENT_CENTS)).toBe(true);
      });

      it("should accept maximum valid amount (1,000,000 cents = $10,000.00)", () => {
        expect(isValidPaymentAmount(MAX_PAYMENT_CENTS)).toBe(true);
      });

      it("should accept mid-range amount (500 cents = $5.00)", () => {
        expect(isValidPaymentAmount(500)).toBe(true);
      });
    });

    describe("Rejects amounts below minimum", () => {
      it("should reject 199 cents (below $2.00 minimum)", () => {
        expect(isValidPaymentAmount(199)).toBe(false);
      });

      it("should reject 0 cents", () => {
        expect(isValidPaymentAmount(0)).toBe(false);
      });
    });

    describe("Rejects amounts above maximum", () => {
      it("should reject 1,000,001 cents (above $10,000 maximum)", () => {
        expect(isValidPaymentAmount(1_000_001)).toBe(false);
      });
    });

    describe("Rejects non-integer amounts", () => {
      it("should reject fractional cents (100.5)", () => {
        expect(isValidPaymentAmount(100.5)).toBe(false);
      });

      it("should reject fractional cents (500.1)", () => {
        expect(isValidPaymentAmount(500.1)).toBe(false);
      });
    });

    describe("Rejects invalid numeric values", () => {
      it("should reject negative amounts", () => {
        expect(isValidPaymentAmount(-100)).toBe(false);
      });

      it("should reject NaN", () => {
        expect(isValidPaymentAmount(NaN)).toBe(false);
      });

      it("should reject Infinity", () => {
        expect(isValidPaymentAmount(Infinity)).toBe(false);
      });

      it("should reject negative Infinity", () => {
        expect(isValidPaymentAmount(-Infinity)).toBe(false);
      });
    });
  });

  describe("isIntentExpired", () => {
    const clock = new FakeClock("2025-01-01T00:00:00.000Z");

    describe("Detects expired intents", () => {
      it("should return false for intent within TTL", () => {
        const now = new Date(clock.now());
        const attempt = createIntentAttempt({
          createdAt: now,
          expiresAt: new Date(now.getTime() + PAYMENT_INTENT_TTL_MS),
        });

        // Check 10 minutes in
        clock.advance(10 * 60 * 1000);
        const checkTime = new Date(clock.now());

        expect(isIntentExpired(attempt, checkTime)).toBe(false);
        clock.reset();
      });

      it("should return true for expired intent (past TTL)", () => {
        const now = new Date(clock.now());
        const expiresAt = new Date(now.getTime() + PAYMENT_INTENT_TTL_MS);
        const attempt = createIntentAttempt({
          createdAt: now,
          expiresAt,
        });

        // Advance past expiration
        clock.advance(PAYMENT_INTENT_TTL_MS + 60 * 1000); // +1 minute past
        const checkTime = new Date(clock.now());

        expect(isIntentExpired(attempt, checkTime)).toBe(true);
        clock.reset();
      });
    });

    describe("Handles boundary conditions (exact TTL, just before/after)", () => {
      it("should return true when exactly at expiration time", () => {
        const now = new Date(clock.now());
        const expiresAt = new Date(now.getTime() + PAYMENT_INTENT_TTL_MS);
        const attempt = createIntentAttempt({
          createdAt: now,
          expiresAt,
        });

        // Exactly at expiration
        clock.advance(PAYMENT_INTENT_TTL_MS);
        const checkTime = new Date(clock.now());

        expect(isIntentExpired(attempt, checkTime)).toBe(true);
        clock.reset();
      });

      it("should return false just before expiration (1 second before)", () => {
        const now = new Date(clock.now());
        const expiresAt = new Date(now.getTime() + PAYMENT_INTENT_TTL_MS);
        const attempt = createIntentAttempt({
          createdAt: now,
          expiresAt,
        });

        // 1 second before expiration
        clock.advance(PAYMENT_INTENT_TTL_MS - 1000);
        const checkTime = new Date(clock.now());

        expect(isIntentExpired(attempt, checkTime)).toBe(false);
        clock.reset();
      });

      it("should return true just after expiration (1 second after)", () => {
        const now = new Date(clock.now());
        const expiresAt = new Date(now.getTime() + PAYMENT_INTENT_TTL_MS);
        const attempt = createIntentAttempt({
          createdAt: now,
          expiresAt,
        });

        // 1 second after expiration
        clock.advance(PAYMENT_INTENT_TTL_MS + 1000);
        const checkTime = new Date(clock.now());

        expect(isIntentExpired(attempt, checkTime)).toBe(true);
        clock.reset();
      });
    });

    describe("Only applies to CREATED_INTENT state", () => {
      it("should return false for PENDING_UNVERIFIED even if expiresAt is past", () => {
        const now = new Date(clock.now());
        const expiresAt = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago

        const attempt = createPaymentAttempt({
          status: "PENDING_UNVERIFIED",
          expiresAt,
        });

        expect(isIntentExpired(attempt, now)).toBe(false);
      });

      it("should return false for CREDITED even if expiresAt is past", () => {
        const now = new Date(clock.now());
        const expiresAt = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago

        const attempt = createPaymentAttempt({
          status: "CREDITED",
          expiresAt,
        });

        expect(isIntentExpired(attempt, now)).toBe(false);
      });

      it("should return false for REJECTED even if expiresAt is past", () => {
        const now = new Date(clock.now());
        const expiresAt = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago

        const attempt = createPaymentAttempt({
          status: "REJECTED",
          expiresAt,
          errorCode: "SENDER_MISMATCH",
        });

        expect(isIntentExpired(attempt, now)).toBe(false);
      });

      it("should return false for FAILED even if expiresAt is past", () => {
        const now = new Date(clock.now());
        const expiresAt = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago

        const attempt = createPaymentAttempt({
          status: "FAILED",
          expiresAt,
          errorCode: "INTENT_EXPIRED",
        });

        expect(isIntentExpired(attempt, now)).toBe(false);
      });
    });

    describe("Returns false for null expiresAt", () => {
      it("should return false when expiresAt is null", () => {
        const now = new Date(clock.now());
        const attempt = createPaymentAttempt({
          status: "CREATED_INTENT",
          expiresAt: null,
        });

        expect(isIntentExpired(attempt, now)).toBe(false);
      });
    });
  });

  describe("isVerificationTimedOut", () => {
    const clock = new FakeClock("2025-01-01T00:00:00.000Z");

    describe("Detects timed out verifications", () => {
      it("should return false within timeout (1 hour)", () => {
        const now = new Date(clock.now());
        const attempt = createPaymentAttempt({
          status: "PENDING_UNVERIFIED",
          submittedAt: now,
          txHash: "0xabc",
        });

        // Check 1 hour later (< 24h)
        clock.advance(60 * 60 * 1000);
        const checkTime = new Date(clock.now());

        expect(isVerificationTimedOut(attempt, checkTime)).toBe(false);
        clock.reset();
      });

      it("should return true when past timeout (25 hours)", () => {
        const now = new Date(clock.now());
        const attempt = createPaymentAttempt({
          status: "PENDING_UNVERIFIED",
          submittedAt: now,
          txHash: "0xabc",
        });

        // Advance 25 hours (> 24h timeout)
        clock.advance(25 * 60 * 60 * 1000);
        const checkTime = new Date(clock.now());

        expect(isVerificationTimedOut(attempt, checkTime)).toBe(true);
        clock.reset();
      });
    });

    describe("Handles boundary conditions (exact 24h, just before/after)", () => {
      it("should return false when exactly at 24h timeout (boundary)", () => {
        const now = new Date(clock.now());
        const attempt = createPaymentAttempt({
          status: "PENDING_UNVERIFIED",
          submittedAt: now,
          txHash: "0xabc",
        });

        // Exactly 24 hours - NOT timed out yet (uses > not >=)
        clock.advance(PENDING_UNVERIFIED_TTL_MS);
        const checkTime = new Date(clock.now());

        expect(isVerificationTimedOut(attempt, checkTime)).toBe(false);
        clock.reset();
      });

      it("should return false just before timeout (1 second before 24h)", () => {
        const now = new Date(clock.now());
        const attempt = createPaymentAttempt({
          status: "PENDING_UNVERIFIED",
          submittedAt: now,
          txHash: "0xabc",
        });

        // 1 second before 24h
        clock.advance(PENDING_UNVERIFIED_TTL_MS - 1000);
        const checkTime = new Date(clock.now());

        expect(isVerificationTimedOut(attempt, checkTime)).toBe(false);
        clock.reset();
      });

      it("should return true just after timeout (1 second after 24h)", () => {
        const now = new Date(clock.now());
        const attempt = createPaymentAttempt({
          status: "PENDING_UNVERIFIED",
          submittedAt: now,
          txHash: "0xabc",
        });

        // 1 second after 24h
        clock.advance(PENDING_UNVERIFIED_TTL_MS + 1000);
        const checkTime = new Date(clock.now());

        expect(isVerificationTimedOut(attempt, checkTime)).toBe(true);
        clock.reset();
      });
    });

    describe("Only applies to PENDING_UNVERIFIED state", () => {
      it("should return false for CREATED_INTENT even if submittedAt is past", () => {
        const now = new Date(clock.now());
        const submittedAt = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 hours ago

        const attempt = createPaymentAttempt({
          status: "CREATED_INTENT",
          submittedAt,
        });

        expect(isVerificationTimedOut(attempt, now)).toBe(false);
      });

      it("should return false for CREDITED even if submittedAt is past", () => {
        const now = new Date(clock.now());
        const submittedAt = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 hours ago

        const attempt = createPaymentAttempt({
          status: "CREDITED",
          submittedAt,
          txHash: "0xabc",
        });

        expect(isVerificationTimedOut(attempt, now)).toBe(false);
      });

      it("should return false for REJECTED even if submittedAt is past", () => {
        const now = new Date(clock.now());
        const submittedAt = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 hours ago

        const attempt = createPaymentAttempt({
          status: "REJECTED",
          submittedAt,
          txHash: "0xabc",
          errorCode: "SENDER_MISMATCH",
        });

        expect(isVerificationTimedOut(attempt, now)).toBe(false);
      });

      it("should return false for FAILED even if submittedAt is past", () => {
        const now = new Date(clock.now());
        const submittedAt = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 hours ago

        const attempt = createPaymentAttempt({
          status: "FAILED",
          submittedAt,
          errorCode: "TX_REVERTED",
        });

        expect(isVerificationTimedOut(attempt, now)).toBe(false);
      });
    });

    describe("Returns false for null submittedAt", () => {
      it("should return false when submittedAt is null", () => {
        const now = new Date(clock.now());
        const attempt = createPaymentAttempt({
          status: "PENDING_UNVERIFIED",
          submittedAt: null,
          txHash: "0xabc",
        });

        expect(isVerificationTimedOut(attempt, now)).toBe(false);
      });
    });
  });

  describe("Constants", () => {
    it("MIN_PAYMENT_CENTS should equal 200", () => {
      expect(MIN_PAYMENT_CENTS).toBe(200);
    });

    it("MAX_PAYMENT_CENTS should equal 1,000,000", () => {
      expect(MAX_PAYMENT_CENTS).toBe(1_000_000);
    });

    it("PAYMENT_INTENT_TTL_MS should equal 30 minutes", () => {
      expect(PAYMENT_INTENT_TTL_MS).toBe(30 * 60 * 1000);
    });

    it("PENDING_UNVERIFIED_TTL_MS should equal 24 hours", () => {
      expect(PENDING_UNVERIFIED_TTL_MS).toBe(24 * 60 * 60 * 1000);
    });
  });
});
