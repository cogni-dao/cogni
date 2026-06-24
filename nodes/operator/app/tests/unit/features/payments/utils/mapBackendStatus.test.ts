// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/payments/utils/mapBackendStatus`
 * Purpose: Unit tests for mapBackendStatus — status → UI phase + structured error.
 * Scope: Tests status mapping and error code → structured PaymentUiError. Does not test business logic.
 * Invariants: All enum values covered; every FAILED maps to a structured error carrying a stable code.
 * Side-effects: none
 * Links: src/features/payments/utils/mapBackendStatus.ts, types/payments.ts
 * @public
 */

import type { PaymentErrorCode, PaymentStatus } from "@cogni/node-core";
import { describe, expect, it } from "vitest";
import { mapBackendStatus } from "@/features/payments/utils/mapBackendStatus";

describe("mapBackendStatus", () => {
  describe("PaymentStatus mapping", () => {
    it("maps PENDING_VERIFICATION to PENDING phase with no error", () => {
      expect(mapBackendStatus("PENDING_VERIFICATION")).toEqual({
        phase: "PENDING",
        result: null,
        error: null,
      });
    });

    it("maps CONFIRMED to DONE phase with SUCCESS result and no error", () => {
      expect(mapBackendStatus("CONFIRMED")).toEqual({
        phase: "DONE",
        result: "SUCCESS",
        error: null,
      });
    });

    it("maps FAILED (no code) to a structured UNKNOWN error", () => {
      const { phase, result, error } = mapBackendStatus("FAILED");
      expect(phase).toBe("DONE");
      expect(result).toBe("ERROR");
      expect(error?.code).toBe("UNKNOWN");
      expect(error?.title).toBeTruthy();
      expect(error?.message).toBeTruthy();
      expect(error?.recoverable).toBe(true);
    });
  });

  describe("PaymentErrorCode → structured error", () => {
    it("maps a code to a structured error carrying that stable code + copy", () => {
      const { error } = mapBackendStatus("FAILED", "SENDER_MISMATCH");
      expect(error?.code).toBe("SENDER_MISMATCH");
      expect(error?.title).toBeTruthy();
      expect(error?.message).toBeTruthy();
    });

    it("never leaks a raw 'debug' field into the UI error", () => {
      const { error } = mapBackendStatus("FAILED", "TX_REVERTED");
      expect(error).not.toHaveProperty("debug");
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
        expect(result.phase).toBeDefined();
      }
    });

    it("maps every PaymentErrorCode to its own stable code (no generic fallthrough)", () => {
      const allCodes: PaymentErrorCode[] = [
        "SENDER_MISMATCH",
        "INVALID_TOKEN",
        "INVALID_RECIPIENT",
        "INVALID_CHAIN",
        "INSUFFICIENT_AMOUNT",
        "INSUFFICIENT_CONFIRMATIONS",
        "TX_NOT_FOUND",
        "TX_REVERTED",
        "TOKEN_TRANSFER_NOT_FOUND",
        "RECIPIENT_MISMATCH",
        "RECEIPT_NOT_FOUND",
        "INTENT_EXPIRED",
        "RPC_ERROR",
      ];
      for (const code of allCodes) {
        const { error } = mapBackendStatus("FAILED", code);
        expect(error?.code).toBe(code); // specific, not "UNKNOWN"
        expect(error?.message).toBeTruthy();
      }
    });
  });
});
