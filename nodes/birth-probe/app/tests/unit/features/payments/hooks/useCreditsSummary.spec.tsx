// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * @vitest-environment jsdom
 *
 * Module: `@features/payments/hooks/useCreditsSummary`
 * Purpose: Unit tests for useCreditsSummary React Query hook with mocked API client.
 * Scope: Tests hook behavior, query key generation, error handling, data transformation. Does NOT test real API.
 * Invariants: Query keys include limit parameter; errors are thrown for React Query error boundaries; data is passed through from client.
 * Side-effects: none (mocked creditsSummaryClient)
 * Notes: Tests happy path, error handling, query key variations with different limit values
 * Links: src/features/payments/hooks/useCreditsSummary.ts
 * @public
 */

import type { CreditsSummaryOutput } from "@cogni/node-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreditsSummary } from "@/features/payments/hooks/useCreditsSummary";

// Mock the creditsSummaryClient module
vi.mock("@/features/payments/api/creditsSummaryClient", () => ({
  creditsSummaryClient: {
    getSummary: vi.fn(),
  },
}));

import { creditsSummaryClient } from "@/features/payments/api/creditsSummaryClient";

describe("useCreditsSummary", () => {
  let queryClient: QueryClient;

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
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false, // Disable retries for tests
        },
      },
    });
  });

  const createWrapper = () => {
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };

  describe("happy path", () => {
    it("fetches and returns credits summary data", async () => {
      vi.mocked(creditsSummaryClient.getSummary).mockResolvedValueOnce({
        ok: true,
        data: mockSuccessResponse,
      });

      const { result } = renderHook(() => useCreditsSummary({ limit: 10 }), {
        wrapper: createWrapper(),
      });

      expect(result.current.isLoading).toBe(true);
      expect(result.current.data).toBeUndefined();

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(mockSuccessResponse);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isError).toBe(false);
    });

    it("calls getSummary with correct limit parameter", async () => {
      vi.mocked(creditsSummaryClient.getSummary).mockResolvedValueOnce({
        ok: true,
        data: mockSuccessResponse,
      });

      renderHook(() => useCreditsSummary({ limit: 25 }), {
        wrapper: createWrapper(),
      });

      await waitFor(() =>
        expect(creditsSummaryClient.getSummary).toHaveBeenCalledWith({
          limit: 25,
        })
      );
    });

    it("calls getSummary with undefined when no options provided", async () => {
      vi.mocked(creditsSummaryClient.getSummary).mockResolvedValueOnce({
        ok: true,
        data: mockSuccessResponse,
      });

      renderHook(() => useCreditsSummary(), {
        wrapper: createWrapper(),
      });

      await waitFor(() =>
        expect(creditsSummaryClient.getSummary).toHaveBeenCalledWith({
          limit: undefined,
        })
      );
    });
  });

  describe("error handling", () => {
    it("throws error when client returns error result", async () => {
      vi.mocked(creditsSummaryClient.getSummary).mockResolvedValueOnce({
        ok: false,
        error: "Unauthorized",
        errorCode: "AUTH_REQUIRED",
      });

      const { result } = renderHook(() => useCreditsSummary({ limit: 10 }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("Unauthorized");
      expect(result.current.data).toBeUndefined();
    });

    it("handles network errors from client", async () => {
      vi.mocked(creditsSummaryClient.getSummary).mockRejectedValueOnce(
        new Error("Network error")
      );

      const { result } = renderHook(() => useCreditsSummary({ limit: 10 }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe("Network error");
    });
  });

  describe("query key generation", () => {
    it("uses query key with limit parameter", async () => {
      vi.mocked(creditsSummaryClient.getSummary).mockResolvedValueOnce({
        ok: true,
        data: mockSuccessResponse,
      });

      const { result } = renderHook(() => useCreditsSummary({ limit: 10 }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      // Verify the query is cached with the correct key
      const cachedData = queryClient.getQueryData([
        "payments-summary",
        { limit: 10 },
      ]);
      expect(cachedData).toEqual(mockSuccessResponse);
    });

    it("creates separate cache entries for different limit values", async () => {
      // First query with limit 10
      vi.mocked(creditsSummaryClient.getSummary).mockResolvedValueOnce({
        ok: true,
        data: mockSuccessResponse,
      });

      const { result: result1 } = renderHook(
        () => useCreditsSummary({ limit: 10 }),
        {
          wrapper: createWrapper(),
        }
      );

      await waitFor(() => expect(result1.current.isSuccess).toBe(true));

      // Second query with limit 25
      const secondResponse: CreditsSummaryOutput = {
        ...mockSuccessResponse,
        ledger: mockSuccessResponse.ledger.slice(0, 25),
      };

      vi.mocked(creditsSummaryClient.getSummary).mockResolvedValueOnce({
        ok: true,
        data: secondResponse,
      });

      const { result: result2 } = renderHook(
        () => useCreditsSummary({ limit: 25 }),
        {
          wrapper: createWrapper(),
        }
      );

      await waitFor(() => expect(result2.current.isSuccess).toBe(true));

      // Verify both queries are cached separately
      const cachedData1 = queryClient.getQueryData([
        "payments-summary",
        { limit: 10 },
      ]);
      const cachedData2 = queryClient.getQueryData([
        "payments-summary",
        { limit: 25 },
      ]);

      expect(cachedData1).toEqual(mockSuccessResponse);
      expect(cachedData2).toEqual(secondResponse);
      expect(creditsSummaryClient.getSummary).toHaveBeenCalledTimes(2);
    });

    it("uses query key with undefined limit when not provided", async () => {
      vi.mocked(creditsSummaryClient.getSummary).mockResolvedValueOnce({
        ok: true,
        data: mockSuccessResponse,
      });

      const { result } = renderHook(() => useCreditsSummary(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      const cachedData = queryClient.getQueryData([
        "payments-summary",
        { limit: undefined },
      ]);
      expect(cachedData).toEqual(mockSuccessResponse);
    });
  });
});
