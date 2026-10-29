// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/metrics-query`
 * Purpose: AI tool for querying system metrics using predefined templates.
 * Scope: Template-based metrics queries. Does NOT allow free-form PromQL.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__metrics_query` (double-underscore for provider compat)
 *   - EFFECT_TYPED: effect is `read_only` (external API but no mutations)
 *   - GOVERNED_METRICS: Only predefined templates, no free-form PromQL
 *   - QUERY_PROVENANCE: Response includes queryRef for audit trail
 *   - REDACTION_REQUIRED: Allowlist in contract
 *   - NO LangChain imports (LangChain wrapping in langgraph-graphs)
 * Side-effects: IO (HTTP requests to metrics backend via capability)
 * Notes: Requires MetricsCapability to be configured
 * Links: TOOL_USE_SPEC.md #17 (GOVERNED_METRICS), #18 (QUERY_PROVENANCE)
 * @public
 */

import { z } from "zod";

import type { MetricsCapability } from "../capabilities/metrics";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input schema for metrics query tool.
 * Per GOVERNED_METRICS: Only predefined templates allowed.
 */
// TODO: Extract allowed values to shared metrics-catalog.ts to sync with Alloy config + mimir adapter
export const MetricsQueryInputSchema = z.object({
  template: z
    .enum([
      "request_rate",
      "error_rate",
      "latency_p50",
      "latency_p95",
      "latency_p99",
      "vm_memory_headroom",
      "vm_disk_headroom",
      "vm_io_pressure",
      "vm_swap_in",
    ])
    .describe("Predefined metric template to query"),
  service: z
    .string()
    .max(64)
    .describe(
      "Service name to query metrics for (ignored by vm_* templates; pass cogni-template)"
    ),
  environment: z
    .enum(["local", "candidate-a", "preview", "production"]) // Must match Alloy DEPLOY_ENVIRONMENT values
    .describe("Deployment environment"),
  window: z
    .enum(["5m", "15m", "1h", "6h"])
    .describe("Time window for the query"),
});
export type MetricsQueryInput = z.infer<typeof MetricsQueryInputSchema>;

/**
 * Series data point schema.
 */
export const MetricsDataPointSchema = z.object({
  timestamp: z.string().datetime().describe("ISO 8601 timestamp"),
  value: z.number().describe("Metric value"),
});
export type MetricsDataPoint = z.infer<typeof MetricsDataPointSchema>;

/**
 * Summary schema.
 */
export const MetricsSummarySchema = z.object({
  current: z.number().describe("Current value at end of window"),
  previous: z.number().optional().describe("Previous value at start of window"),
  changePercent: z
    .number()
    .optional()
    .describe("Percent change from previous to current"),
});
export type MetricsSummary = z.infer<typeof MetricsSummarySchema>;

/**
 * Output schema for metrics query tool.
 * Per QUERY_PROVENANCE: Includes queryRef for audit trail.
 */
export const MetricsQueryOutputSchema = z.object({
  queryRef: z.string().describe("Unique query reference for audit trail"),
  executedAt: z
    .string()
    .datetime()
    .describe("ISO 8601 timestamp when query was executed"),
  summary: MetricsSummarySchema.describe("Summary statistics"),
  series: z
    .array(MetricsDataPointSchema)
    .max(100)
    .describe("Time series data points (max 100)"),
  truncated: z.boolean().describe("Whether series was truncated due to limits"),
});
export type MetricsQueryOutput = z.infer<typeof MetricsQueryOutputSchema>;

/**
 * Redacted output (same as output - metrics data is not sensitive).
 * Per REDACTION_REQUIRED: Allowlist in contract.
 */
export type MetricsQueryRedacted = MetricsQueryOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Namespaced tool ID per TOOL_ID_NAMESPACED invariant.
 * Uses double-underscore separator (provider-compatible: OpenAI allows [a-zA-Z0-9_-]+)
 */
export const METRICS_QUERY_NAME = "core__metrics_query" as const;

export const metricsQueryContract: ToolContract<
  typeof METRICS_QUERY_NAME,
  MetricsQueryInput,
  MetricsQueryOutput,
  MetricsQueryRedacted
> = {
  name: METRICS_QUERY_NAME,
  description:
    "Query system metrics using predefined templates. Returns request rates, error rates, " +
    "and latency percentiles for specified services. Available templates: request_rate, " +
    "error_rate, latency_p50, latency_p95, latency_p99. Available services: cogni-template. " +
    "For host/VM health ('is production healthy', memory, disk, swap, I/O) use the vm_* " +
    "templates for the environment's shared VM (candidate-a, preview, production; not local): " +
    "vm_memory_headroom and vm_disk_headroom (% free, lower is worse), vm_io_pressure " +
    "(% time stalled on I/O, higher is worse), vm_swap_in (pages/s swapped in over 5m). " +
    "Report summary.current; an error or no data means the signal is UNKNOWN, never healthy.",
  effect: "read_only",
  inputSchema: MetricsQueryInputSchema,
  outputSchema: MetricsQueryOutputSchema,

  redact: (output: MetricsQueryOutput): MetricsQueryRedacted => {
    // No sensitive data - return full output
    return output;
  },

  allowlist: [
    "queryRef",
    "executedAt",
    "summary",
    "series",
    "truncated",
  ] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for metrics query implementation.
 * Per AUTH_VIA_CAPABILITY_INTERFACE: Auth resolved via capability.
 */
export interface MetricsQueryDeps {
  metricsCapability: MetricsCapability;
}

/**
 * Create metrics query implementation with injected dependencies.
 * Per capability pattern: implementation receives capability at construction.
 */
export function createMetricsQueryImplementation(
  deps: MetricsQueryDeps
): ToolImplementation<MetricsQueryInput, MetricsQueryOutput> {
  return {
    execute: async (input: MetricsQueryInput): Promise<MetricsQueryOutput> => {
      const result = await deps.metricsCapability.queryTemplate({
        template: input.template,
        service: input.service,
        environment: input.environment,
        window: input.window,
      });

      return {
        queryRef: result.queryRef,
        executedAt: result.executedAt,
        summary: result.summary,
        series: result.series,
        truncated: result.truncated,
      };
    },
  };
}

/**
 * Stub implementation that throws when metrics capability is not configured.
 * Used as default placeholder in catalog.
 */
export const metricsQueryStubImplementation: ToolImplementation<
  MetricsQueryInput,
  MetricsQueryOutput
> = {
  execute: async (): Promise<MetricsQueryOutput> => {
    throw new Error(
      "MetricsCapability not configured. Set PROMETHEUS_QUERY_URL (or PROMETHEUS_REMOTE_WRITE_URL " +
        "ending in /api/prom/push) + PROMETHEUS_READ_USERNAME + PROMETHEUS_READ_PASSWORD."
    );
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Bound Tool (contract + stub implementation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bound tool with stub implementation.
 * Real implementation injected at runtime via createMetricsQueryImplementation.
 */
export const metricsQueryBoundTool: BoundTool<
  typeof METRICS_QUERY_NAME,
  MetricsQueryInput,
  MetricsQueryOutput,
  MetricsQueryRedacted
> = {
  contract: metricsQueryContract,
  implementation: metricsQueryStubImplementation,
};
