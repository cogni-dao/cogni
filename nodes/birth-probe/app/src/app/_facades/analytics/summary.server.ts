// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/analytics/summary.server`
 * Purpose: App-layer facade for analytics summary. Resolves dependencies, calls service, maps internal types to contract.
 * Scope: Server-only facade. Wires MetricsQueryPort from container, delegates to analytics service, maps Date to ISO string. Does not handle HTTP or validation.
 * Invariants: No session required (public endpoint); env hardcoded from runtime; return types use z.infer from contract.
 * Side-effects: IO (via MetricsQueryPort)
 * Notes: Type mapping from service result to contract output happens here (service uses Date, contract uses ISO string).
 * Links: Used by /api/v1/analytics/summary route handler.
 * @public
 */

import type { AnalyticsSummaryOutput } from "@cogni/node-contracts";
import { getContainer } from "@/bootstrap/container";
import { getAnalyticsSummary } from "@/features/analytics/services/analytics";
import { serverEnv } from "@/shared/env";

export interface GetAnalyticsSummaryFacadeParams {
  window: string; // "7d", "30d", "90d"
}

/**
 * Get analytics summary facade.
 * Wires dependencies and maps internal result to contract output.
 */
export async function getAnalyticsSummaryFacade(
  params: GetAnalyticsSummaryFacadeParams
): Promise<AnalyticsSummaryOutput> {
  const container = getContainer();
  const env = serverEnv();

  // Call service with port and env config
  const result = await getAnalyticsSummary(container.metricsQuery, {
    window: params.window,
    env: env.DEPLOY_ENVIRONMENT ?? "local",
    kThreshold: env.ANALYTICS_K_THRESHOLD,
  });

  // Map internal types (Date) to contract types (ISO string)
  const output: AnalyticsSummaryOutput = {
    window: result.window as "7d" | "30d" | "90d",
    generatedAt: result.generatedAt.toISOString(),
    cacheTtlSeconds: result.cacheTtlSeconds,
    summary: result.summary,
    timeseries: {
      requestRate: result.timeseries.requestRate.map((point) => ({
        timestamp: point.timestamp.toISOString(),
        value: point.value,
      })),
      tokenRate: result.timeseries.tokenRate.map((point) => ({
        timestamp: point.timestamp.toISOString(),
        value: point.value,
      })),
      errorRate: result.timeseries.errorRate.map((point) => ({
        timestamp: point.timestamp.toISOString(),
        value: point.value,
      })),
    },
    distribution: result.distribution,
  };

  return output;
}
