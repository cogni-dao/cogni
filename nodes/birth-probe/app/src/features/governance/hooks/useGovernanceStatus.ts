// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/hooks/useGovernanceStatus`
 * Purpose: React Query hook for governance status dashboard with 30s polling.
 * Scope: Client-side data fetching for /gov page. Does not access database or server-side services directly.
 * Invariants: 30s polling interval; typed with contract output schema.
 * Side-effects: IO (HTTP GET to /api/v1/governance/status); React Query cache.
 * Links: src/contracts/governance.status.v1.contract.ts
 * @public
 */

import type { governanceStatusOutputSchema } from "@cogni/node-contracts";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { z } from "zod";

type GovernanceStatus = z.infer<typeof governanceStatusOutputSchema>;

export function useGovernanceStatus(): UseQueryResult<GovernanceStatus, Error> {
  return useQuery({
    queryKey: ["governance", "status"],
    queryFn: async () => {
      const res = await fetch("/api/v1/governance/status");
      if (!res.ok) throw new Error("Failed to fetch governance status");
      return res.json() as Promise<GovernanceStatus>;
    },
    refetchInterval: 30_000,
  });
}
