// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/metrics`
 * Purpose: Metrics capability interface for AI tool execution.
 * Scope: Defines MetricsCapability for template-based metrics queries. Does NOT implement transport.
 * Invariants:
 *   - GOVERNED_METRICS: Only predefined templates, no free-form PromQL
 *   - QUERY_PROVENANCE: All results include queryRef for audit trail
 *   - NO_SECRETS_IN_CONTEXT: Capability resolves auth, never stored in context
 * Side-effects: none (interface only)
 * Links: TOOL_USE_SPEC.md #17 (GOVERNED_METRICS), #18 (QUERY_PROVENANCE)
 * @public
 */

/**
 * Predefined metric query templates.
 * Per GOVERNED_METRICS: Only these templates are allowed - no free-form PromQL.
 */
export type MetricTemplate =
  | "request_rate"
  | "error_rate"
  | "latency_p50"
  | "latency_p95"
  | "latency_p99"
  // Host/VM health (story.5105): the env's single substrate VM, read from the
  // reliability-policy series exactly as scripts/vm-health-snapshot.mjs does.
  | "vm_memory_headroom"
  | "vm_disk_headroom"
  | "vm_io_pressure"
  | "vm_swap_in";

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
  environment: "local" | "candidate-a" | "preview" | "production";
  /** Time window for the query */
  window: MetricWindow;
}

/**
 * Single data point in a metric time series.
 */
export interface MetricDataPoint {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Metric value */
  value: number;
}

/**
 * Summary statistics for the queried metric.
 */
export interface MetricSummary {
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
export interface MetricQueryResult {
  /** Unique query reference for audit trail */
  queryRef: string;
  /** ISO 8601 timestamp when query was executed */
  executedAt: string;
  /** Whether result came from cache */
  cached: boolean;
  /** Summary statistics */
  summary: MetricSummary;
  /** Time series data points (max 100) */
  series: MetricDataPoint[];
  /** Whether series was truncated due to limits */
  truncated: boolean;
}

/**
 * Metrics capability for AI tools.
 *
 * Per GOVERNED_METRICS (TOOL_USE_SPEC.md #17):
 * Only template-based queries are supported. Free-form PromQL is not allowed.
 *
 * Per AUTH_VIA_CAPABILITY_INTERFACE:
 * Auth is resolved by the capability implementation, not passed in context.
 */
export interface MetricsCapability {
  /**
   * Execute a template-based metrics query.
   *
   * @param params - Query parameters (template, service, environment, window)
   * @returns Query result with summary and time series
   * @throws If service/environment not in allowlist or query fails
   */
  queryTemplate(params: TemplateQueryParams): Promise<MetricQueryResult>;
}
