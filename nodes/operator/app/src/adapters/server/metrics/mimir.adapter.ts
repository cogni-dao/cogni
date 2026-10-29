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
import { RELIABILITY_POLICY_V1 } from "@cogni/node-contracts";

import type {
  InstantQueryParams,
  MetricsQueryPort,
  MetricTemplate,
  MetricWindow,
  PrometheusInstantResult,
  PrometheusRangeResult,
  RangeQueryParams,
  ReliabilityMetricsSnapshot,
  ReliabilityQueryParams,
  TemplateDataPoint,
  TemplateQueryParams,
  TemplateQueryResult,
  TemplateSummary,
} from "@/ports";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

const logger = makeLogger({ component: "MimirMetricsAdapter" });

type ReadinessQueryInput = {
  readonly environment: ReliabilityQueryParams["environment"];
  readonly nodeSlug: string;
};

const serveSelector = (input: ReadinessQueryInput) =>
  `probe_success{environment="${input.environment}",node_slug="${input.nodeSlug}",proof_class="serve"}`;
const serveWindow = (input: ReadinessQueryInput) =>
  RELIABILITY_POLICY_V1.serveProbes[input.environment].evidenceWindow;

/**
 * Worst serve readiness per probe region over the policy evidence window.
 * Probe cadence differs per environment (bug.5527), so the window is never a
 * literal; grouping by region keeps a check re-version (new config_version
 * series) from reading as a duplicate region.
 */
export function buildReliabilityReadinessQuery(
  input: ReadinessQueryInput
): string {
  return `min by (probe) (min_over_time(${serveSelector(input)}[${serveWindow(input)}]))`;
}

/**
 * Real last-sample time per probe region. An instant query stamps results with
 * the evaluation time; timestamp() inside the subquery keeps the sample time,
 * so a stopped or deleted check ages out instead of reading fresh (bug.5527).
 * The subquery step adds up to one step of apparent age on top of the probe
 * cadence; 10s keeps 60s production probes inside the 120s TTL (a 1m step
 * measured p99 115s / max 133s).
 */
export const READINESS_SAMPLE_TIME_STEP = "10s";

export function buildReliabilityReadinessSampleTimeQuery(
  input: ReadinessQueryInput
): string {
  return `max by (probe) (max_over_time(timestamp(${serveSelector(input)})[${serveWindow(input)}:${READINESS_SAMPLE_TIME_STEP}]))`;
}

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
  "vm_memory_headroom",
  "vm_disk_headroom",
  "vm_io_pressure",
  "vm_swap_in",
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

type VmTemplate = Extract<MetricTemplate, `vm_${string}`>;
type ServiceTemplate = Exclude<MetricTemplate, VmTemplate>;

const isVmTemplate = (template: MetricTemplate): template is VmTemplate =>
  template.startsWith("vm_");

/** Envs with a shared substrate VM recorded by the reliability policy. */
const VM_ENVIRONMENTS: readonly TemplateQueryParams["environment"][] = [
  "candidate-a",
  "preview",
  "production",
];

/**
 * Host/VM health templates (story.5105). These mirror
 * scripts/vm-health-snapshot.mjs: the same recorded cogni_reliability_v1_*
 * series under the same policy selector, the same evidence TTL, the CLI's
 * 32-hex substrate_host guard, policy-worst aggregation across
 * node_slug/instance recordings (min for headroom, max for pressure), and one
 * row per substrate_host so an ambiguous env fails closed through
 * MULTI_SERIES_RESULT. Swap-in is the CLI's rate(node_vmstat_pswpin[5m]),
 * deduped across instance and gated to the host the policy attests for the env.
 */
const VM_HOST_LABEL = 'substrate_host=~"[0-9a-f]{32}"';
const VM_TTL_SEC = RELIABILITY_POLICY_V1.evidenceTtlMs / 1000;
const VM_POLICY_SERIES: Record<
  Exclude<VmTemplate, "vm_swap_in">,
  { readonly metric: string; readonly aggregation: "min" | "max" }
> = {
  vm_memory_headroom: {
    metric: "cogni_reliability_v1_memory_headroom_percent",
    aggregation: "min",
  },
  vm_disk_headroom: {
    metric: "cogni_reliability_v1_disk_headroom_percent",
    aggregation: "min",
  },
  vm_io_pressure: {
    metric: "cogni_reliability_v1_io_pressure_percent",
    aggregation: "max",
  },
};

const freshVmSelector = (selector: string): string =>
  `(${selector} and (time() - timestamp(${selector}) <= ${VM_TTL_SEC}))`;

const vmPolicySelector = (metric: string, environment: string): string =>
  `${metric}{environment="${environment}",policy_version="${RELIABILITY_POLICY_V1.version}",${VM_HOST_LABEL}}`;

function buildVmPromQL(
  template: VmTemplate,
  environment: TemplateQueryParams["environment"]
): string {
  if (template === "vm_swap_in") {
    const attestedHost = freshVmSelector(
      vmPolicySelector(VM_POLICY_SERIES.vm_memory_headroom.metric, environment)
    );
    return `max by (substrate_host) (rate(node_vmstat_pswpin{env="${environment}",${VM_HOST_LABEL}}[5m])) and on (substrate_host) count by (substrate_host) ${attestedHost}`;
  }
  const { metric, aggregation } = VM_POLICY_SERIES[template];
  return `${aggregation} by (substrate_host) ${freshVmSelector(vmPolicySelector(metric, environment))}`;
}

/** Template → PromQL mapping. Labels: app (not service), env (not environment) */
const TEMPLATE_PROMQL: Record<ServiceTemplate, string> = {
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
 * Build PromQL from template. Pure function; callers validate params first.
 */
export function buildTemplatePromQL(params: TemplateQueryParams): string {
  if (isVmTemplate(params.template))
    return buildVmPromQL(params.template, params.environment);
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

export type MimirAdapterConfig = {
  url: string;
  timeoutMs: number;
} & (
  | { username: string; password: string; bearerToken?: never }
  | { bearerToken: string; username?: never; password?: never }
);

/**
 * Mimir adapter for Prometheus metrics queries.
 * Implements Prometheus HTTP API v1 query and query_range endpoints.
 */
export class MimirMetricsAdapter implements MetricsQueryPort {
  constructor(private readonly config: MimirAdapterConfig) {
    if (
      "bearerToken" in config &&
      (!config.bearerToken || config.username || config.password)
    )
      throw new Error("mimir_bearer_auth_invalid");
  }

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

  async queryReliabilitySnapshot(
    params: ReliabilityQueryParams
  ): Promise<ReliabilityMetricsSnapshot> {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(params.nodeSlug)) {
      throw new Error("invalid reliability node slug");
    }

    const env = params.environment;
    const node = params.nodeSlug;
    const substrateHost = /^[0-9a-f]{32}$/.test(params.substrateHost ?? "")
      ? params.substrateHost
      : null;
    const identity = `environment="${env}",node_slug="${node}",database_tier="${params.databaseTier ?? "unknown"}",budget_profile="${params.budgetProfile ?? "unknown"}",policy_version="reliability-status-v1",substrate_host="${substrateHost ?? "unknown"}"`;
    const queries = {
      readiness: buildReliabilityReadinessQuery({
        environment: env,
        nodeSlug: node,
      }),
      io: `cogni_reliability_v1_io_pressure_percent{${identity}}`,
      connections: `cogni_reliability_v1_connections_percent{${identity}}`,
      memory: `cogni_reliability_v1_memory_headroom_percent{${identity}}`,
      disk: `cogni_reliability_v1_disk_headroom_percent{${identity}}`,
      backendShare: `cogni_reliability_v1_database_backends_share_percent{${identity}}`,
      physicalReadShare: `cogni_reliability_v1_database_physical_reads_share_percent{${identity}}`,
      tempBytesShare: `cogni_reliability_v1_database_temp_bytes_share_percent{${identity}}`,
    } as const;

    const evaluationTime = new Date();
    const signalQueries = [
      queries.io,
      queries.connections,
      queries.memory,
      queries.disk,
      queries.backendShare,
      queries.physicalReadShare,
      queries.tempBytesShare,
    ];
    // Query evaluation time is not the recording timestamp. Both reads use one
    // fixed evaluation instant; timestamp(selector) supplies the actual source time.
    const valueReads = Promise.all(
      [queries.readiness, ...signalQueries].map((query) =>
        this.queryInstant({ query, time: evaluationTime })
      )
    );
    const timestampReads = Promise.all(
      signalQueries.map((query) =>
        this.queryInstant({
          query: `timestamp(${query})`,
          time: evaluationTime,
        })
      )
    );
    const readinessSampleTimeRead = this.queryInstant({
      query: buildReliabilityReadinessSampleTimeQuery({
        environment: env,
        nodeSlug: node,
      }),
      time: evaluationTime,
    });
    const [valueResults, sourceResults, readinessSampleTimes] =
      await Promise.all([valueReads, timestampReads, readinessSampleTimeRead]);
    const readinessSampledAt = new Map(
      readinessSampleTimes.result.map(
        (sample) =>
          [sample.metric.probe ?? "", Number(sample.value[1])] as const
      )
    );
    const labels = (metric: Readonly<Record<string, string>>) =>
      JSON.stringify(
        Object.entries(metric)
          .filter(([key]) => key !== "__name__")
          .sort(([a], [b]) => a.localeCompare(b))
      );
    const withSourceTime = (
      value: PrometheusInstantResult,
      timestamp: PrometheusInstantResult
    ): PrometheusInstantResult => {
      const signal = value.result[0];
      const source = timestamp.result[0];
      const recordedAt = Number(source?.value[1]);
      if (
        value.result.length !== 1 ||
        timestamp.result.length !== 1 ||
        !signal ||
        !source ||
        labels(signal.metric) !== labels(source.metric) ||
        !Number.isFinite(recordedAt) ||
        recordedAt <= 0 ||
        signal.value[0] !== source.value[0]
      )
        return { resultType: "vector", result: [] };
      return {
        resultType: "vector",
        result: [
          { metric: signal.metric, value: [recordedAt, signal.value[1]] },
        ],
      };
    };
    const readiness = valueResults[0];
    if (!readiness) throw new Error("reliability_readiness_result_missing");
    const [
      io,
      connections,
      memory,
      disk,
      backendShare,
      physicalReadShare,
      tempBytesShare,
    ] = signalQueries.map((_, index) => {
      const value = valueResults[index + 1];
      const timestamp = sourceResults[index];
      if (!value || !timestamp)
        throw new Error("reliability_source_timestamp_result_missing");
      return withSourceTime(value, timestamp);
    });
    if (
      !io ||
      !connections ||
      !memory ||
      !disk ||
      !backendShare ||
      !physicalReadShare ||
      !tempBytesShare
    )
      throw new Error("reliability_source_timestamp_result_missing");

    const expectedLabels = {
      environment: env,
      node_slug: node,
      database_tier: params.databaseTier,
      budget_profile: params.budgetProfile,
      policy_version: "reliability-status-v1",
      substrate_host: substrateHost ?? null,
    };
    const observedAtSeconds = Date.now() / 1000;
    const attributed = (result: PrometheusInstantResult) =>
      singleAttributedSample(result, expectedLabels, observedAtSeconds);
    const ioSample = attributed(io);
    const connectionSample = attributed(connections);
    const backendShareSample = attributed(backendShare);
    const physicalReadShareSample = attributed(physicalReadShare);
    const tempBytesShareSample = attributed(tempBytesShare);
    const coTemporal = (
      signal: AttributedSample | null,
      share: AttributedSample | null
    ) =>
      signal !== null &&
      share !== null &&
      Math.abs(signal.observedAtSeconds - share.observedAtSeconds) * 1000 <=
        RELIABILITY_POLICY_V1.maxSignalAttributionSkewMs;
    const databaseShare5m = {
      backendsPct: coTemporal(connectionSample, backendShareSample)
        ? (backendShareSample?.value ?? null)
        : null,
      physicalReadsPct: coTemporal(ioSample, physicalReadShareSample)
        ? (physicalReadShareSample?.value ?? null)
        : null,
      tempBytesPct: coTemporal(ioSample, tempBytesShareSample)
        ? (tempBytesShareSample?.value ?? null)
        : null,
    };
    const hasCompleteDatabaseAttribution = Object.values(databaseShare5m).every(
      (value) => value !== null && Number.isFinite(value)
    );

    return {
      regionalReadiness: readiness.result
        .flatMap((sample) => {
          const region =
            sample.metric.probe ??
            sample.metric.region ??
            sample.metric.instance ??
            "unknown";
          const sampledAt = readinessSampledAt.get(region);
          // No proven sample time is no readiness evidence (missing is unknown).
          if (
            sampledAt === undefined ||
            !Number.isFinite(sampledAt) ||
            sampledAt <= 0
          )
            return [];
          return [
            {
              region,
              healthy: Number(sample.value[1]) >= 1,
              observedAt: new Date(sampledAt * 1000).toISOString(),
            },
          ];
        })
        .sort((a, b) => a.region.localeCompare(b.region)),
      evidenceScope: hasCompleteDatabaseAttribution
        ? "node"
        : "environment-shared",
      ioPressurePct:
        coTemporal(ioSample, physicalReadShareSample) &&
        coTemporal(ioSample, tempBytesShareSample)
          ? (ioSample?.value ?? null)
          : null,
      connectionPct: coTemporal(connectionSample, backendShareSample)
        ? (connectionSample?.value ?? null)
        : null,
      memoryHeadroomPct: attributed(memory)?.value ?? null,
      diskHeadroomPct: attributed(disk)?.value ?? null,
      databaseShare5m: hasCompleteDatabaseAttribution
        ? databaseShare5m
        : { backendsPct: null, physicalReadsPct: null, tempBytesPct: null },
      evidenceQueryRefs: Object.keys(queries).map(
        (signal) => `reliability.v1:${env}:${node}:${signal}`
      ),
    };
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

    // vm_* templates read the env's shared VM; service is never interpolated.
    const vm = isVmTemplate(params.template);
    if (vm && !VM_ENVIRONMENTS.includes(params.environment)) {
      throw new TemplateQueryError(
        "ENVIRONMENT_NOT_ALLOWED",
        `${params.template} has no shared VM in environment: ${params.environment}`
      );
    }

    // Validate service allowlist
    if (
      !vm &&
      !(ALLOWED_SERVICES as readonly string[]).includes(params.service)
    ) {
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
    const promql = buildTemplatePromQL(params);
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
    // MISSING_IS_UNKNOWN: a VM signal without fresh evidence is never 0/healthy.
    if (vm && series.length === 0) {
      throw new TemplateQueryError(
        "NO_DATA",
        `${params.template} has no fresh evidence for ${params.environment}; treat as UNKNOWN`
      );
    }
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
    const authHeader =
      "bearerToken" in this.config
        ? `Bearer ${this.config.bearerToken}`
        : `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs
    );

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        redirect: "error",
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

interface AttributedSample {
  readonly value: number;
  readonly observedAtSeconds: number;
}

function singleAttributedSample(
  result: PrometheusInstantResult,
  expectedLabels: Readonly<Record<string, string | null>>,
  observedAtSeconds: number
): AttributedSample | null {
  const sample = result.result[0];
  if (
    result.result.length !== 1 ||
    !sample ||
    Object.entries(expectedLabels).some(
      ([key, expected]) => expected === null || sample.metric[key] !== expected
    ) ||
    sample.value[0] > observedAtSeconds + 15 ||
    observedAtSeconds - sample.value[0] >
      RELIABILITY_POLICY_V1.evidenceTtlMs / 1000
  ) {
    return null;
  }
  const value = Number(sample.value[1]);
  return Number.isFinite(value)
    ? { value, observedAtSeconds: sample.value[0] }
    : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

export type TemplateQueryErrorCode =
  | "UNKNOWN_TEMPLATE"
  | "SERVICE_NOT_ALLOWED"
  | "MULTI_SERIES_RESULT"
  | "ENVIRONMENT_NOT_ALLOWED"
  | "NO_DATA";

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
