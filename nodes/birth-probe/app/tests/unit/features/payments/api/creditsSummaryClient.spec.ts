// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/api/creditsSummaryClient`
 * Purpose: Unit tests for credits summary API client with mocked HTTP calls and error handling.
 * Scope: Tests client logic, parameter handling, response parsing, discriminated union returns. Does NOT test real API.
 * Invariants: No real HTTP calls; deterministic responses; validates discriminated union pattern; handles errors gracefully.
 * Side-effects: none (mocked fetch)
 * Notes: Tests happy path, 4xx errors, network errors, invalid responses, query parameter building
 * Links: src/features/payments/api/creditsSummaryClient.ts
 * @public
 */

import type { CreditsSummaryOutput } from "@cogni/node-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { creditsSummaryClient } from "@/features/payments/api/creditsSummaryClient";

describe("creditsSummaryClient", () => {
  // Mock fetch globally
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const mockSuccessResponse: CreditsSummaryOutput = {
    billingAccountId: "billing-123",
    balanceCredits: 5000,
    ledger: [
      {
        id: "ledger-1",
        amount: 1000,
        balanceAfter: 5000,
        reason: "widget_payment",
        reference: "payment-1",
        metadata: null,
        createdAt: "2025-01-15T10:00:00Z",
      },
      {
        id: "ledger-2",
        amount: 4000,
        balanceAfter: 4000,
        reason: "widget_payment",
        reference: "payment-2",
        metadata: { txHash: "0xabc" },
        createdAt: "2025-01-14T10:00:00Z",
      },
    ],
  };

  describe("getSummary", () => {
    it("returns data on successful response (happy path)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse,
      });

      const result = await creditsSummaryClient.getSummary();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost/api/v1/payments/credits/summary"
      );
      expect(result).toEqual({
        ok: true,
        data: mockSuccessResponse,
      });
    });

    it("includes limit query parameter when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse,
      });

      const result = await creditsSummaryClient.getSummary({ limit: 10 });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost/api/v1/payments/credits/summary?limit=10"
      );
      expect(result.ok).toBe(true);
    });

    it("omits query parameters when limit is undefined", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSuccessResponse,
      });

      const result = await creditsSummaryClient.getSummary({});

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost/api/v1/payments/credits/summary"
      );
      expect(result.ok).toBe(true);
    });

    it("returns error on 4xx response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({
          error: "Unauthorized",
          errorCode: "AUTH_REQUIRED",
        }),
      });

      const result = await creditsSummaryClient.getSummary();

      expect(result).toEqual({
        ok: false,
        error: "Unauthorized",
        errorCode: "AUTH_REQUIRED",
      });
      expect(console.error).toHaveBeenCalledWith(
        "[CLIENT] ERROR client.payments.credits_summary_http_error",
        '{"status":401,"error":"Unauthorized","errorCode":"AUTH_REQUIRED"}'
      );
    });

    it("returns error on 500 response with generic message", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({
          errorMessage: "Internal Server Error",
        }),
      });

      const result = await creditsSummaryClient.getSummary();

      expect(result).toEqual({
        ok: false,
        error: "Internal Server Error",
        errorCode: undefined,
      });
    });

    it("handles network error by returning error result", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await creditsSummaryClient.getSummary();

      expect(result).toEqual({
        ok: false,
        error: "Network error",
      });
      expect(console.error).toHaveBeenCalledWith(
        "[CLIENT] ERROR client.payments.credits_summary_network_error",
        '{"error":"Network error"}'
      );
    });

    it("handles invalid JSON response gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("Invalid JSON");
        },
      });

      const result = await creditsSummaryClient.getSummary();

      expect(result).toEqual({
        ok: false,
        error: "Invalid response",
        errorCode: undefined,
      });
    });

    it("uses error field from response body when available", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          error: "Bad Request - Invalid limit",
        }),
      });

      const result = await creditsSummaryClient.getSummary({ limit: 200 });

      expect(result).toEqual({
        ok: false,
        error: "Bad Request - Invalid limit",
        errorCode: undefined,
      });
    });

    it("falls back to 'Request failed' when no error message in body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({}),
      });

      const result = await creditsSummaryClient.getSummary();

      expect(result).toEqual({
        ok: false,
        error: "Request failed",
        errorCode: undefined,
      });
    });

    it("handles empty ledger array", async () => {
      const emptyResponse: CreditsSummaryOutput = {
        billingAccountId: "billing-456",
        balanceCredits: 0,
        ledger: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => emptyResponse,
      });

      const result = await creditsSummaryClient.getSummary();

      expect(result).toEqual({
        ok: true,
        data: emptyResponse,
      });
    });
  });
});
