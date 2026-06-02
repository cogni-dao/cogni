// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/hooks/useCreditsSummary`
 * Purpose: React Query hook for fetching credits balance and ledger entries.
 * Scope: Wraps creditsSummaryClient with React Query for caching, loading states, and error handling. Does not manage payment flow or state machines.
 * Invariants: Query key includes limit parameter for separate cache entries per limit value.
 * Side-effects: IO (creditsSummaryClient); React Query cache (useQuery).
 * Notes: Throws errors on failure for React Query error boundary compatibility.
 * Links: docs/spec/payments-design.md
 * @public
 */

import type { CreditsSummaryOutput } from "@cogni/node-contracts";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { creditsSummaryClient } from "../api/creditsSummaryClient";

export interface UseCreditsSummaryOptions {
  /**
   * Maximum number of ledger entries to return (1-100).
   * Defaults to undefined (server default applies).
   */
  limit?: number;
}

/**
 * Fetches credits balance and recent ledger entries for the authenticated user.
 *
 * @param options - Query options (limit for ledger entries)
 * @returns React Query result with credits summary data
 *
 * @example
 * ```tsx
 * const summaryQuery = useCreditsSummary({ limit: 10 });
 *
 * if (summaryQuery.isLoading) return <div>Loading...</div>;
 * if (summaryQuery.isError) return <div>Error: {summaryQuery.error.message}</div>;
 *
 * const { balanceCredits, ledger } = summaryQuery.data;
 * ```
 */
export function useCreditsSummary(
  options: UseCreditsSummaryOptions = {}
): UseQueryResult<CreditsSummaryOutput, Error> {
  const { limit } = options;

  return useQuery({
    queryKey: ["payments-summary", { limit }],
    queryFn: async () => {
      const result = await creditsSummaryClient.getSummary({ limit });
      if (!result.ok) {
        throw new Error(result.error);
      }
      return result.data;
    },
  });
}
