// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/metrics/mimir.adapter`
 * Purpose: Prometheus HTTP API client for metrics queries (compatible with Grafana Cloud Mimir).
 * Scope: Implements MetricsQueryPort; HTTP client for Prometheus query API; handles auth, timeout, error mapping. Does not implement query building, k-anonymity logic, or caching.
 * Invariants: Uses basic auth; respects timeout via AbortSignal; converts HTTP errors to exceptions.
 * Side-effects: IO (HTTP requests to Prometheus/Mimir)
 * Notes: Queries use Prometheus HTTP API v1 format (query, query_range).
 * Links: Used by analytics service via container; uses PROMETHEUS_QUERY_URL + PROMETHEUS_READ_USERNAME/PASSWORD.
 * @internal
 */

import { createHash } from "node:crypto";

import type {
  InstantQueryParams,
  MetricsQueryPort,
  MetricTemplate,
  MetricWindow,
  PrometheusInstantResult,
  PrometheusRangeResult,
  RangeQueryParams,
  TemplateDataPoint,
  TemplateQueryParams,
  TemplateQueryResult,
  TemplateSummary,
} from "@/ports";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

const logger = makeLogger({ component: "MimirMetricsAdapter" });

// ─────────────────────────────────────────────────────────────────────────────
// Template Query Configuration (GOVERNED_METRICS)
// TODO: Extract to shared metrics-catalog.ts to sync with Alloy config + tool description
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_SERVICES = ["cogni-template"] as const; // Must match Alloy scrape targets
const ALLOWED_TEMPLATES: readonly MetricTemplate[] = [
  "request_rate",
  "error_rate",
  "latency_p50",
  "latency_p95",
  "latency_p99",
];

/** Max lookback per window */
const WINDOW_SECONDS: Record<MetricWindow, number> = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
};

/** Query step per window for reasonable resolution */
const WINDOW_STEP: Record<MetricWindow, string> = {
  "5m": "15s",
  "15m": "30s",
  "1h": "1m",
  "6h": "5m",
};

/** Max data points enforced before query */
const MAX_POINTS = 100;

/** Template → PromQL mapping. Labels: app (not service), env (not environment) */
const TEMPLATE_PROMQL: Record<MetricTemplate, string> = {
  request_rate:
    'sum(rate(http_requests_total{app="{service}", env="{environment}"}[{window}]))',
  error_rate:
    'sum(rate(http_requests_total{app="{service}", env="{environment}", status=~"5.."}[{window}])) / sum(rate(http_requests_total{app="{service}", env="{environment}"}[{window}])) * 100',
  latency_p50:
    'histogram_quantile(0.50, sum(rate(http_request_duration_ms_bucket{app="{service}", env="{environment}"}[{window}])) by (le))',
  latency_p95:
    'histogram_quantile(0.95, sum(rate(http_request_duration_ms_bucket{app="{service}", env="{environment}"}[{window}])) by (le))',
  latency_p99:
    'histogram_quantile(0.99, sum(rate(http_request_duration_ms_bucket{app="{service}", env="{environment}"}[{window}])) by (le))',
};

/**
 * Build PromQL from template. Pure function.
 */
function buildPromQL(params: TemplateQueryParams): string {
  const template = TEMPLATE_PROMQL[params.template];
  return template
    .replace(/{service}/g, params.service)
    .replace(/{environment}/g, params.environment)
    .replace(/{window}/g, params.window);
}

/**
 * Generate deterministic queryRef from params.
 * Hash of template+service+environment+window+step+endTimeBucket (1min buckets).
 */
function generateQueryRef(
  params: TemplateQueryParams,
  step: string,
  endTime: Date
): string {
  const bucket = Math.floor(endTime.getTime() / 60000); // 1-minute buckets
  const input = `${params.template}|${params.service}|${params.environment}|${params.window}|${step}|${bucket}`;
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 12);
  return `mqt_${hash}`;
}

export interface MimirAdapterConfig {
  url: string; // Grafana Cloud Mimir endpoint
  username: string; // Basic auth username
  password: string; // Basic auth password/token
  timeoutMs: number; // Query timeout in milliseconds
}

/**
 * Mimir adapter for Prometheus metrics queries.
 * Implements Prometheus HTTP API v1 query and query_range endpoints.
 */
export class MimirMetricsAdapter implements MetricsQueryPort {
  constructor(private readonly config: MimirAdapterConfig) {}

  /**
   * Execute a range query (query_range).
   * Maps Date objects to Unix timestamps for Prometheus API.
   */
  async queryRange(params: RangeQueryParams): Promise<PrometheusRangeResult> {
    const url = new URL(`${this.config.url}/api/v1/query_range`);
    url.searchParams.set("query", params.query);
    url.searchParams.set(
      "start",
      Math.floor(params.start.getTime() / 1000).toString()
    );
    url.searchParams.set(
      "end",
      Math.floor(params.end.getTime() / 1000).toString()
    );
    url.searchParams.set("step", params.step);

    const result = await this.fetch<PrometheusRangeResult>(url);
    return result;
  }

  /**
   * Execute an instant query (query).
   * Evaluates PromQL at a single point in time.
   */
  async queryInstant(
    params: InstantQueryParams
  ): Promise<PrometheusInstantResult> {
    const url = new URL(`${this.config.url}/api/v1/query`);
    url.searchParams.set("query", params.query);
    if (params.time) {
      url.searchParams.set(
        "time",
        Math.floor(params.time.getTime() / 1000).toString()
      );
    }

    const result = await this.fetch<PrometheusInstantResult>(url);
    return result;
  }

  /**
   * Execute a template-based metrics query.
   * Per GOVERNED_METRICS: validates allowlists, enforces limits, rejects multi-series.
   */
  async queryTemplate(
    params: TemplateQueryParams
  ): Promise<TemplateQueryResult> {
    // Validate template
    if (!ALLOWED_TEMPLATES.includes(params.template)) {
      logger.error(
        {
          event: EVENT_NAMES.ADAPTER_MIMIR_ERROR,
          dep: "mimir",
          reasonCode: "unknown_template",
        },
        EVENT_NAMES.ADAPTER_MIMIR_ERROR
      );
      throw new TemplateQueryError(
        "UNKNOWN_TEMPLATE",
        `Unknown template: ${params.template}`
      );
    }

    // Validate service allowlist
    if (!(ALLOWED_SERVICES as readonly string[]).includes(params.service)) {
      logger.error(
        {
          event: EVENT_NAMES.ADAPTER_MIMIR_ERROR,
          dep: "mimir",
          reasonCode: "service_not_allowed",
        },
        EVENT_NAMES.ADAPTER_MIMIR_ERROR
      );
      throw new TemplateQueryError(
        "SERVICE_NOT_ALLOWED",
        `Service not in allowlist: ${params.service}`
      );
    }

    // Calculate time range and step
    const endTime = new Date();
    const windowSeconds = WINDOW_SECONDS[params.window];
    const startTime = new Date(endTime.getTime() - windowSeconds * 1000);
    const step = WINDOW_STEP[params.window];

    // Generate deterministic queryRef BEFORE query
    const queryRef = generateQueryRef(params, step, endTime);
    const executedAt = endTime.toISOString();

    // Build PromQL and execute
    const promql = buildPromQL(params);
    const rawResult = await this.queryRange({
      query: promql,
      start: startTime,
      end: endTime,
      step,
    });

    // FAIL CLOSED: reject multi-series results
    if (rawResult.result.length > 1) {
      logger.error(
        {
          event: EVENT_NAMES.ADAPTER_MIMIR_ERROR,
          dep: "mimir",
          reasonCode: "multi_series_result",
        },
        EVENT_NAMES.ADAPTER_MIMIR_ERROR
      );
      throw new TemplateQueryError(
        "MULTI_SERIES_RESULT",
        `Template query returned ${rawResult.result.length} series; expected 1`
      );
    }

    // Transform result
    const series = this.transformToDataPoints(rawResult);
    const truncated = series.length > MAX_POINTS;
    const limitedSeries = series.slice(0, MAX_POINTS);
    const summary = this.calculateSummary(limitedSeries);

    return {
      queryRef,
      executedAt,
      cached: false,
      summary,
      series: limitedSeries,
      truncated,
    };
  }

  /**
   * Transform Prometheus range result to TemplateDataPoint array.
   */
  private transformToDataPoints(
    result: PrometheusRangeResult
  ): TemplateDataPoint[] {
    if (result.result.length === 0) {
      return [];
    }

    const series = result.result[0];
    if (!series) {
      return [];
    }

    return series.values
      .map(([timestamp, valueStr]) => ({
        timestamp: new Date(timestamp * 1000).toISOString(),
        value: parseFloat(valueStr),
      }))
      .filter((dp) => !Number.isNaN(dp.value));
  }

  /**
   * Calculate summary statistics from series.
   */
  private calculateSummary(series: TemplateDataPoint[]): TemplateSummary {
    if (series.length === 0) {
      return { current: 0 };
    }

    const lastPoint = series[series.length - 1];
    const current = lastPoint?.value ?? 0;

    if (series.length < 2) {
      return { current };
    }

    const firstPoint = series[0];
    const previous = firstPoint?.value ?? 0;

    if (previous === 0) {
      return { current, previous };
    }

    const changePercent =
      Math.round(((current - previous) / previous) * 100 * 100) / 100;

    return { current, previous, changePercent };
  }

  /**
   * Internal fetch with auth, timeout, and error handling.
   */
  private async fetch<T>(url: URL): Promise<T> {
    const authHeader = `Basic ${Buffer.from(
      `${this.config.username}:${this.config.password}`
    ).toString("base64")}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs
    );

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.error(
          {
            event: EVENT_NAMES.ADAPTER_MIMIR_ERROR,
            dep: "mimir",
            reasonCode: "http_error",
            status: response.status,
          },
          EVENT_NAMES.ADAPTER_MIMIR_ERROR
        );
        throw new Error(
          `Mimir query failed: ${response.status} ${response.statusText}`
        );
      }

      const json = await response.json();

      // Prometheus API wraps results in { status: "success", data: ... }
      if (json.status !== "success") {
        logger.error(
          {
            event: EVENT_NAMES.ADAPTER_MIMIR_ERROR,
            dep: "mimir",
            reasonCode: "api_error",
          },
          EVENT_NAMES.ADAPTER_MIMIR_ERROR
        );
        throw new Error(`Mimir query error: ${json.error || "Unknown error"}`);
      }

      return json.data as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        logger.error(
          {
            event: EVENT_NAMES.ADAPTER_MIMIR_ERROR,
            dep: "mimir",
            reasonCode: "timeout",
            durationMs: this.config.timeoutMs,
          },
          EVENT_NAMES.ADAPTER_MIMIR_ERROR
        );
        throw new Error(`Mimir query timeout after ${this.config.timeoutMs}ms`);
      }
      // Log network-level errors (DNS, connection refused, TLS, etc.)
      const reasonCode =
        error instanceof Error && error.message === "fetch failed"
          ? "network_error"
          : "unknown_error";
      logger.error(
        {
          event: EVENT_NAMES.ADAPTER_MIMIR_ERROR,
          dep: "mimir",
          reasonCode,
        },
        EVENT_NAMES.ADAPTER_MIMIR_ERROR
      );
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

export type TemplateQueryErrorCode =
  | "UNKNOWN_TEMPLATE"
  | "SERVICE_NOT_ALLOWED"
  | "MULTI_SERIES_RESULT";

/**
 * Error thrown for template query validation/execution failures.
 * Stable error codes for testing.
 */
export class TemplateQueryError extends Error {
  constructor(
    public readonly code: TemplateQueryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TemplateQueryError";
  }
}
