// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/analytics.summary.v1.contract`
 * Purpose: Contract for public analytics summary endpoint with privacy guarantees.
 * Scope: Defines response schema for /api/v1/analytics/summary; does not implement query logic.
 * Invariants: Fixed time windows only (7d/30d/90d); all numeric values nullable (k-anonymity); no PII.
 * Side-effects: none
 * Notes: Public endpoint with aggressive caching; k-anonymity suppression at service layer.
 * Links: https://node-template.cognidao.org/knowledge/public-analytics-privacy
 * @public
 */

import { z } from "zod";

/**
 * Time window for analytics query.
 * Fixed windows prevent arbitrary time range correlation attacks.
 */
export const analyticsWindowSchema = z.enum(["7d", "30d", "90d"]);

/**
 * Single data point in a time series.
 * Value is nullable to indicate k-anonymity suppression.
 */
export const analyticsDataPointSchema = z.object({
  timestamp: z.string(), // ISO 8601 timestamp
  value: z.number().nullable(), // null indicates suppressed bucket
});

/**
 * Time series data for a single metric.
 */
export const analyticsTimeseriesSchema = z.array(analyticsDataPointSchema);

/**
 * Summary statistics for the entire time window.
 * All values nullable for k-anonymity suppression.
 */
export const analyticsSummaryStatsSchema = z.object({
  totalRequests: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  errorRatePercent: z.number().min(0).max(100).nullable(),
  latencyP50Ms: z.number().nonnegative().nullable(),
  latencyP95Ms: z.number().nonnegative().nullable(),
});

/**
 * Model class distribution (by token count).
 * All values nullable for k-anonymity suppression.
 */
export const modelClassDistributionSchema = z.object({
  free: z.number().int().nonnegative().nullable(),
  standard: z.number().int().nonnegative().nullable(),
  premium: z.number().int().nonnegative().nullable(),
});

/**
 * Analytics summary operation.
 */
export const analyticsSummaryOperation = {
  id: "analytics.summary.v1",
  summary: "Get aggregated platform metrics for public transparency page",
  description:
    "Returns anonymized, aggregated metrics over fixed time windows with k-anonymity suppression.",
  input: z.object({
    window: analyticsWindowSchema.optional().default("7d"),
  }),
  output: z.object({
    window: analyticsWindowSchema,
    generatedAt: z.string(), // ISO 8601 timestamp
    cacheTtlSeconds: z.number().int().positive(),
    summary: analyticsSummaryStatsSchema,
    timeseries: z.object({
      requestRate: analyticsTimeseriesSchema,
      tokenRate: analyticsTimeseriesSchema,
      errorRate: analyticsTimeseriesSchema,
    }),
    distribution: z.object({
      modelClass: modelClassDistributionSchema,
    }),
  }),
} as const;

export type AnalyticsWindow = z.infer<typeof analyticsWindowSchema>;
export type AnalyticsDataPoint = z.infer<typeof analyticsDataPointSchema>;
export type AnalyticsTimeseries = z.infer<typeof analyticsTimeseriesSchema>;
export type AnalyticsSummaryStats = z.infer<typeof analyticsSummaryStatsSchema>;
export type ModelClassDistribution = z.infer<
  typeof modelClassDistributionSchema
>;
export type AnalyticsSummaryInput = z.infer<
  typeof analyticsSummaryOperation.input
>;
export type AnalyticsSummaryOutput = z.infer<
  typeof analyticsSummaryOperation.output
>;
