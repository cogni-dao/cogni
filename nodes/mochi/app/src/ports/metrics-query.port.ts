// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/metrics-query.port`
 * Purpose: Port interface for querying Prometheus-compatible time-series databases (Mimir, Prometheus).
 * Scope: Defines contract for metrics queries; does not implement HTTP transport or query building.
 * Invariants: All timestamps are Date objects; errors bubble as adapter-specific exceptions.
 * Side-effects: none (interface only)
 * Notes: Supports both instant and range queries per Prometheus HTTP API spec.
 * Links: Implemented by MimirMetricsAdapter; consumed by analytics service.
 * @public
 */

/**
 * Single data point in a Prometheus time series.
 * Per Prometheus HTTP API: [unix_timestamp_seconds, sample_value_string] tuple.
 */
export type PrometheusDataPoint = [number, string];

/**
 * Time series result with metric labels and data points.
 */
export interface PrometheusTimeSeries {
  metric: Record<string, string>; // Label key-value pairs
  values: PrometheusDataPoint[]; // Array of [timestamp, value_string] tuples
}

/**
 * Result from query_range endpoint.
 * Contains multiple time series matching the query.
 */
export interface PrometheusRangeResult {
  resultType: "matrix";
  result: PrometheusTimeSeries[];
}

/**
 * Single instant value with metric labels.
 */
export interface PrometheusInstantValue {
  metric: Record<string, string>;
  value: [number, string]; // [timestamp, value as string]
}

/**
 * Result from query endpoint (instant query).
 * Contains vector of instant values.
 */
export interface PrometheusInstantResult {
  resultType: "vector";
  result: PrometheusInstantValue[];
}

/**
 * Parameters for range query.
 */
export interface RangeQueryParams {
  /** PromQL expression */
  query: string;
  /** Start timestamp */
  start: Date;
  /** End timestamp */
  end: Date;
  /** Query resolution step (e.g., "1h", "5m") */
  step: string;
}

/**
 * Parameters for instant query.
 */
export interface InstantQueryParams {
  /** PromQL expression */
  query: string;
  /** Evaluation timestamp (optional, defaults to now) */
  time?: Date;
}

/**
 * Port for querying Prometheus-compatible metrics backends.
 * Supports both range and instant queries per Prometheus HTTP API.
 */
export interface MetricsQueryPort {
  /**
   * Execute a range query (query_range).
   * Returns time series data over a specified time range with given resolution.
   */
  queryRange(params: RangeQueryParams): Promise<PrometheusRangeResult>;

  /**
   * Execute an instant query (query).
   * Returns metric values at a single point in time.
   */
  queryInstant(params: InstantQueryParams): Promise<PrometheusInstantResult>;

  /**
   * Execute a template-based metrics query.
   * Per GOVERNED_METRICS: Only predefined templates allowed, no free-form PromQL.
   *
   * @param params - Template query parameters
   * @returns Query result with summary and time series
   * @throws If service/environment not in allowlist or query fails
   */
  queryTemplate?(params: TemplateQueryParams): Promise<TemplateQueryResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template Query Types (for AI tool access)
// Per GOVERNED_METRICS invariant: Only predefined templates, no free-form PromQL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Predefined metric query templates.
 * Per GOVERNED_METRICS: Only these templates are allowed.
 */
export type MetricTemplate =
  | "request_rate"
  | "error_rate"
  | "latency_p50"
  | "latency_p95"
  | "latency_p99";

/**
 * Time window for metric queries.
 */
export type MetricWindow = "5m" | "15m" | "1h" | "6h";

/**
 * Parameters for template-based metrics queries.
 */
export interface TemplateQueryParams {
  /** Predefined template to execute */
  template: MetricTemplate;
  /** Service name (must be in allowlist) */
  service: string;
  /** Deployment environment (must match Alloy DEPLOY_ENVIRONMENT values) */
  environment: "local" | "preview" | "production";
  /** Time window for the query */
  window: MetricWindow;
}

/**
 * Single data point in a metric time series.
 */
export interface TemplateDataPoint {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Metric value */
  value: number;
}

/**
 * Summary statistics for the queried metric.
 */
export interface TemplateSummary {
  /** Current value at end of window */
  current: number;
  /** Previous value (start of window), if available */
  previous?: number;
  /** Percent change from previous to current */
  changePercent?: number;
}

/**
 * Result from a template-based metrics query.
 * Per QUERY_PROVENANCE: Always includes queryRef for audit trail.
 */
export interface TemplateQueryResult {
  /** Unique query reference for audit trail */
  queryRef: string;
  /** ISO 8601 timestamp when query was executed */
  executedAt: string;
  /** Whether result came from cache */
  cached: boolean;
  /** Summary statistics */
  summary: TemplateSummary;
  /** Time series data points (max 100) */
  series: TemplateDataPoint[];
  /** Whether series was truncated due to limits */
  truncated: boolean;
}
