// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/payments/utils/mapBackendStatus`
 * Purpose: Unit tests for mapBackendStatus utility covering all PaymentStatus and PaymentErrorCode mappings.
 * Scope: Tests status → UI phase mapping and error code → message conversion. Does not test business logic.
 * Invariants: All enum values covered; messages are user-friendly; type safety validated.
 * Side-effects: none
 * Notes: Validates single source of truth for status interpretation.
 * Links: src/features/payments/utils/mapBackendStatus.ts, types/payments.ts
 * @public
 */

import type { PaymentErrorCode, PaymentStatus } from "@cogni/node-core";
import { describe, expect, it } from "vitest";
import { mapBackendStatus } from "@/features/payments/utils/mapBackendStatus";

describe("mapBackendStatus", () => {
  describe("PaymentStatus mapping", () => {
    it("maps PENDING_VERIFICATION to PENDING phase", () => {
      const result = mapBackendStatus("PENDING_VERIFICATION");

      expect(result).toEqual({
        phase: "PENDING",
        result: null,
        errorMessage: null,
      });
    });

    it("maps CONFIRMED to DONE phase with SUCCESS result", () => {
      const result = mapBackendStatus("CONFIRMED");

      expect(result).toEqual({
        phase: "DONE",
        result: "SUCCESS",
        errorMessage: null,
      });
    });

    it("maps FAILED to DONE phase with ERROR result", () => {
      const result = mapBackendStatus("FAILED");

      expect(result).toEqual({
        phase: "DONE",
        result: "ERROR",
        errorMessage: "Payment failed",
      });
    });
  });

  describe("PaymentErrorCode message mapping", () => {
    it("maps SENDER_MISMATCH to user-friendly message", () => {
      const result = mapBackendStatus("FAILED", "SENDER_MISMATCH");

      expect(result.errorMessage).toBe(
        "Transaction sender does not match your wallet"
      );
    });

    it("maps INVALID_TOKEN to user-friendly message", () => {
      const result = mapBackendStatus("FAILED", "INVALID_TOKEN");

      expect(result.errorMessage).toBe("Wrong token used for payment");
    });

    it("maps INSUFFICIENT_AMOUNT to user-friendly message", () => {
      const result = mapBackendStatus("FAILED", "INSUFFICIENT_AMOUNT");

      expect(result.errorMessage).toBe("Payment amount too low");
    });

    it("maps TX_REVERTED to user-friendly message", () => {
      const result = mapBackendStatus("FAILED", "TX_REVERTED");

      expect(result.errorMessage).toBe("Transaction reverted on-chain");
    });

    it("maps RECEIPT_NOT_FOUND to user-friendly message", () => {
      const result = mapBackendStatus("FAILED", "RECEIPT_NOT_FOUND");

      expect(result.errorMessage).toBe("Transaction not found after 24 hours");
    });

    it("maps INTENT_EXPIRED to user-friendly message", () => {
      const result = mapBackendStatus("FAILED", "INTENT_EXPIRED");

      expect(result.errorMessage).toBe("Payment intent expired");
    });

    it("returns default message for undefined errorCode", () => {
      const result = mapBackendStatus("FAILED", undefined);

      expect(result.errorMessage).toBe("Payment failed");
    });
  });

  describe("Type safety validation", () => {
    it("covers all PaymentStatus enum values", () => {
      const allStatuses: PaymentStatus[] = [
        "PENDING_VERIFICATION",
        "CONFIRMED",
        "FAILED",
      ];

      for (const status of allStatuses) {
        const result = mapBackendStatus(status);
        expect(result).toBeDefined();
        expect(result.phase).toBeDefined();
      }
    });

    it("covers all PaymentErrorCode enum values", () => {
      const allCodes: PaymentErrorCode[] = [
        "SENDER_MISMATCH",
        "INVALID_TOKEN",
        "INVALID_RECIPIENT",
        "INSUFFICIENT_AMOUNT",
        "INSUFFICIENT_CONFIRMATIONS",
        "TX_REVERTED",
        "RECEIPT_NOT_FOUND",
        "INTENT_EXPIRED",
        "RPC_ERROR",
      ];

      for (const code of allCodes) {
        const result = mapBackendStatus("FAILED", code);
        expect(result.errorMessage).toBeDefined();
        expect(result.errorMessage).not.toBe("Payment failed"); // Should have specific message
      }
    });
  });
});
