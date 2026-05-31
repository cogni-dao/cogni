// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/analytics/services/analytics`
 * Purpose: Analytics service for querying aggregated platform metrics with k-anonymity.
 * Scope: Builds PromQL queries, applies k-anonymity suppression, returns internal result types. Does not implement HTTP transport or contract mapping.
 * Invariants: All queries include env and route filters; k-anonymity threshold enforced; no client-controlled queries.
 * Side-effects: IO (via MetricsQueryPort)
 * Notes: Env filter hardcoded from DEPLOY_ENVIRONMENT; k-threshold from env.
 * Links: Used by analytics facade; queries Mimir via MetricsQueryPort.
 * @public
 */

import type { MetricsQueryPort } from "@/ports";

/**
 * Time window configuration with bucket size.
 */
interface WindowConfig {
  durationSeconds: number; // Total duration in seconds
  step: string; // Prometheus step (e.g., "1h", "6h", "1d")
  bucketLabel: string; // Human-readable label (e.g., "per hour")
}

const WINDOW_CONFIGS: Record<string, WindowConfig> = {
  "7d": {
    durationSeconds: 7 * 24 * 60 * 60, // 7 days
    step: "1h",
    bucketLabel: "per hour",
  },
  "30d": {
    durationSeconds: 30 * 24 * 60 * 60, // 30 days
    step: "6h",
    bucketLabel: "per 6 hours",
  },
  "90d": {
    durationSeconds: 90 * 24 * 60 * 60, // 90 days
    step: "1d",
    bucketLabel: "per day",
  },
};

/**
 * Single data point in internal format.
 */
export interface AnalyticsDataPoint {
  timestamp: Date;
  value: number | null;
}

/**
 * Summary statistics (internal).
 */
export interface AnalyticsSummaryStats {
  totalRequests: number | null;
  totalTokens: number | null;
  errorRatePercent: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

/**
 * Model class distribution (internal).
 */
export interface ModelClassDistribution {
  free: number | null;
  standard: number | null;
  premium: number | null;
}

/**
 * Analytics summary result (internal format - facade maps to contract types).
 */
export interface AnalyticsSummaryResult {
  window: string;
  generatedAt: Date;
  cacheTtlSeconds: number;
  summary: AnalyticsSummaryStats;
  timeseries: {
    requestRate: AnalyticsDataPoint[];
    tokenRate: AnalyticsDataPoint[];
    errorRate: AnalyticsDataPoint[];
  };
  distribution: {
    modelClass: ModelClassDistribution;
  };
}

/**
 * Parameters for analytics query.
 */
export interface GetAnalyticsSummaryParams {
  window: string; // "7d", "30d", "90d"
  env: string; // Deployment environment (e.g., "local", "preview", "production")
  kThreshold: number; // K-anonymity threshold
}

/**
 * Get analytics summary with k-anonymity suppression.
 */
export async function getAnalyticsSummary(
  metricsQuery: MetricsQueryPort,
  params: GetAnalyticsSummaryParams
): Promise<AnalyticsSummaryResult> {
  const config = WINDOW_CONFIGS[params.window];
  if (!config) {
    throw new Error(`Invalid window: ${params.window}`);
  }

  const now = new Date();
  const start = new Date(now.getTime() - config.durationSeconds * 1000);

  // Build base filters
  const baseFilters = `app="cogni-template",env="${params.env}",route!="meta.metrics"`;

  // Query request count denominator (for k-anonymity)
  const denominatorQuery = `sum(increase(http_requests_total{${baseFilters}}[${config.step}]))`;
  const denominatorResult = await metricsQuery.queryRange({
    query: denominatorQuery,
    start,
    end: now,
    step: config.step,
  });

  // Extract denominator values (request counts per bucket)
  const requestCounts: number[] = [];
  if (denominatorResult.result.length > 0) {
    const series = denominatorResult.result[0];
    if (series) {
      for (const [, valueStr] of series.values) {
        requestCounts.push(Number.parseFloat(valueStr ?? "0"));
      }
    }
  }

  // Query all metrics in parallel
  const [
    totalRequestsResult,
    totalTokensResult,
    errorRateResult,
    requestRateResult,
    tokenRateResult,
    errorRateTimeseriesResult,
  ] = await Promise.all([
    // Total requests
    metricsQuery.queryInstant({
      query: `sum(increase(http_requests_total{${baseFilters}}[${params.window}]))`,
      time: now,
    }),
    // Total tokens
    metricsQuery.queryInstant({
      query: `sum(increase(ai_llm_tokens_total{app="cogni-template",env="${params.env}"}[${params.window}]))`,
      time: now,
    }),
    // Error rate (percentage)
    metricsQuery.queryInstant({
      query: `(sum(increase(http_requests_total{${baseFilters},status="5xx"}[${params.window}])) / sum(increase(http_requests_total{${baseFilters}}[${params.window}]))) * 100`,
      time: now,
    }),
    // Request rate timeseries
    metricsQuery.queryRange({
      query: `sum(increase(http_requests_total{${baseFilters}}[${config.step}]))`,
      start,
      end: now,
      step: config.step,
    }),
    // Token rate timeseries
    metricsQuery.queryRange({
      query: `sum(increase(ai_llm_tokens_total{app="cogni-template",env="${params.env}"}[${config.step}]))`,
      start,
      end: now,
      step: config.step,
    }),
    // Error rate timeseries
    metricsQuery.queryRange({
      query: `(sum(increase(http_requests_total{${baseFilters},status="5xx"}[${config.step}])) / sum(increase(http_requests_total{${baseFilters}}[${config.step}]))) * 100`,
      start,
      end: now,
      step: config.step,
    }),
  ]);

  // Apply k-anonymity suppression to summary stats
  const totalRequests = extractScalar(totalRequestsResult);
  const totalTokens = extractScalar(totalTokensResult);
  const errorRate = extractScalar(errorRateResult);

  // Check if total requests meet k-threshold
  const meetsThreshold =
    totalRequests !== null && totalRequests >= params.kThreshold;

  const summary: AnalyticsSummaryStats = {
    totalRequests: meetsThreshold ? totalRequests : null,
    totalTokens: meetsThreshold ? totalTokens : null,
    errorRatePercent: meetsThreshold && errorRate !== null ? errorRate : null,
    latencyP50Ms: null, // TODO: Implement latency queries
    latencyP95Ms: null, // TODO: Implement latency queries
  };

  // Apply k-anonymity suppression to timeseries (pointwise)
  const requestRate = applyKAnonymity(
    extractTimeseries(requestRateResult),
    requestCounts,
    params.kThreshold
  );
  const tokenRate = applyKAnonymity(
    extractTimeseries(tokenRateResult),
    requestCounts,
    params.kThreshold
  );
  const errorRateTimeseries = applyKAnonymity(
    extractTimeseries(errorRateTimeseriesResult),
    requestCounts,
    params.kThreshold
  );

  return {
    window: params.window,
    generatedAt: now,
    cacheTtlSeconds: 60,
    summary,
    timeseries: {
      requestRate,
      tokenRate,
      errorRate: errorRateTimeseries,
    },
    distribution: {
      modelClass: {
        free: null, // TODO: Implement model class distribution
        standard: null,
        premium: null,
      },
    },
  };
}

/**
 * Extract scalar value from instant query result.
 */
function extractScalar(result: {
  resultType: string;
  result: Array<{ value: [number, string] }>;
}): number | null {
  if (result.result.length === 0) return null;
  const value = result.result[0]?.value[1];
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Extract timeseries from range query result.
 * Per Prometheus HTTP API: values are [unix_timestamp, sample_value_string] tuples.
 */
function extractTimeseries(result: {
  resultType: string;
  result: Array<{ values: Array<[number, string]> }>;
}): AnalyticsDataPoint[] {
  if (result.result.length === 0) return [];
  const series = result.result[0];
  if (!series) return [];

  return series.values.map(([timestamp, valueStr]) => ({
    timestamp: new Date(timestamp * 1000),
    value: Number.parseFloat(valueStr),
  }));
}

/**
 * Apply k-anonymity suppression to timeseries.
 * Suppress buckets where request count < k.
 */
function applyKAnonymity(
  timeseries: AnalyticsDataPoint[],
  requestCounts: number[],
  kThreshold: number
): AnalyticsDataPoint[] {
  return timeseries.map((point, index) => {
    const requestCount = requestCounts[index] ?? 0;
    const meetThreshold = requestCount >= kThreshold;
    return {
      timestamp: point.timestamp,
      value: meetThreshold ? point.value : null,
    };
  });
}
