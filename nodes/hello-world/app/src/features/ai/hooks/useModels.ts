// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/hooks/useModels`
 * Purpose: Provides React Query hook for fetching available AI models.
 * Scope: Wraps /api/v1/ai/models endpoint with React Query for caching and loading states. Does not implement API endpoint or caching logic (delegates to React Query and route).
 * Invariants: 5-minute stale time, re-fetches on window focus.
 * Side-effects: IO (fetch to API endpoint), global (React Query cache)
 * Notes: Validates response with contract schema; errors propagate to caller.
 * Links: /api/v1/ai/models route, ai.models.v1.contract
 * @public
 */

import { aiModelsOperation, type ModelsOutput } from "@cogni/node-contracts";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";

/**
 * Fetches available AI models list with tier information
 *
 * @returns React Query result with models array and defaultModelId
 *
 * @example
 * ```tsx
 * const modelsQuery = useModels();
 *
 * if (modelsQuery.isLoading) return <div>Loading...</div>;
 * if (modelsQuery.isError) return <div>Using default model</div>;
 *
 * const { models, defaultModelId } = modelsQuery.data;
 * ```
 */
export function useModels(): UseQueryResult<ModelsOutput, Error> {
  return useQuery({
    queryKey: ["ai-models"],
    queryFn: async (): Promise<ModelsOutput> => {
      const response = await fetch("/api/v1/ai/models");

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.statusText}`);
      }

      const data = await response.json();

      // Validate response with contract
      const parseResult = aiModelsOperation.output.safeParse(data);
      if (!parseResult.success) {
        throw new Error("Invalid models data from API");
      }

      return parseResult.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: true,
  });
}
