// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/treasury/components/TreasuryBadge.spec`
 * Purpose: Regression test ensuring TreasuryBadge renders without wallet or session.
 * Scope: Tests public data invariant - treasury balance accessible to all users. Does not test wallet integration or auth flows.
 * Invariants: TreasuryBadge MUST render without authentication; graceful degradation on API errors.
 * Side-effects: none (mocked fetch)
 * Links: docs/spec/onchain-readers.md
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TreasuryBadge } from "@/features/treasury/components/TreasuryBadge";

/**
 * Regression test: TreasuryBadge MUST render without wallet or session.
 * Treasury data is public DAO-level data and should never require authentication.
 */
describe("TreasuryBadge - Public Data", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    global.fetch = vi.fn();
  });

  it("renders loading state without wallet connection", () => {
    // Mock fetch to never resolve (loading state)
    vi.mocked(global.fetch).mockImplementation(
      () => new Promise(() => {}) as Promise<Response>
    );

    render(
      <QueryClientProvider client={queryClient}>
        <TreasuryBadge />
      </QueryClientProvider>
    );

    // Should render placeholder without crashing
    expect(screen.getByText("Treasury")).toBeInTheDocument();
    expect(screen.getByText(/--/)).toBeInTheDocument();
  });

  it("renders balance data without wallet connection", async () => {
    // Mock successful API response
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        treasuryAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
        chainId: 11155111,
        blockNumber: 1000000n,
        balances: [
          {
            token: "USDC",
            tokenAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
            balanceWei: 3726420000n,
            balanceFormatted: "3726.42",
            decimals: 6,
          },
        ],
        timestamp: Date.now(),
        staleWarning: false,
      }),
    } as Response);

    render(
      <QueryClientProvider client={queryClient}>
        <TreasuryBadge />
      </QueryClientProvider>
    );

    // Wait for data to load
    await waitFor(() => {
      expect(screen.getByText("Treasury")).toBeInTheDocument();
      expect(screen.getByText(/\$ 3,726/)).toBeInTheDocument();
    });
  });

  it("handles API error gracefully without wallet connection", async () => {
    // Mock API error
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    render(
      <QueryClientProvider client={queryClient}>
        <TreasuryBadge />
      </QueryClientProvider>
    );

    // Should render placeholder on error (graceful degradation)
    await waitFor(() => {
      expect(screen.getByText("Treasury")).toBeInTheDocument();
      expect(screen.getByText(/--/)).toBeInTheDocument();
    });
  });
});
