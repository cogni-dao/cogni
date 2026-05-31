// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/observability/server/metrics`
 * Purpose: Prometheus metrics registry and metric definitions for observability.
 * Scope: Shared observability singleton. Provides metrics registry and recording helpers. Does not implement HTTP transport or scrape endpoints.
 * Invariants: Single registry per process via globalThis; labels always low-cardinality; survives HMR; node_id from repo-spec (NODE_IDENTITY_IN_OBSERVABILITY).
 * Side-effects: global (module-scoped registry via globalThis)
 * Notes: Uses getOrCreate pattern to prevent duplicate registration errors during HMR/tests.
 * Links: Consumed by route handlers and features; exposed via /api/metrics endpoint.
 * @public
 */

import fs from "node:fs";
import path from "node:path";

import type { AiExecutionErrorCode } from "@cogni/ai-core";
import { extractNodeId, parseRepoSpec } from "@cogni/repo-spec";
import type { Counter, Gauge, Histogram, Registry } from "prom-client";
import client from "prom-client";

function getOrCreateGauge<T extends string>(
  name: string,
  help: string,
  labelNames: readonly T[] = [] as readonly T[]
): Gauge<T> {
  const existing = metricsRegistry.getSingleMetric(name);
  if (existing) return existing as Gauge<T>;
  return new client.Gauge({
    name,
    help,
    labelNames: labelNames as T[],
    registers: [metricsRegistry],
  });
}

/**
 * Read node_id from .cogni/repo-spec.yaml at module scope.
 * Uses @cogni/repo-spec pure functions directly (no serverEnv() dependency).
 * Falls back to "unknown" if repo-spec is missing (e.g., in unit tests).
 */
function readNodeIdForMetrics(): string {
  try {
    const repoRoot = process.env.COGNI_REPO_ROOT ?? process.cwd();
    const specPath = path.join(repoRoot, ".cogni", "repo-spec.yaml");
    const content = fs.readFileSync(specPath, "utf8");
    return extractNodeId(parseRepoSpec(content));
  } catch {
    return "unknown";
  }
}

// Singleton via globalThis to survive HMR/test reloads
const globalForMetrics = globalThis as typeof globalThis & {
  metricsRegistry?: Registry;
  metricsInitialized?: boolean;
};

export const metricsRegistry: Registry =
  globalForMetrics.metricsRegistry ?? new client.Registry();

if (!globalForMetrics.metricsInitialized) {
  globalForMetrics.metricsRegistry = metricsRegistry;
  globalForMetrics.metricsInitialized = true;

  metricsRegistry.setDefaultLabels({
    app: "cogni-template",
    env: process.env.DEPLOY_ENVIRONMENT ?? "local",
    node_id: readNodeIdForMetrics(),
  });
  client.collectDefaultMetrics({ register: metricsRegistry });
}

// =============================================================================
// Metric Factory Helpers (prevent duplicate registration)
// =============================================================================

function getOrCreateCounter<T extends string>(
  name: string,
  help: string,
  labelNames: readonly T[] = [] as readonly T[]
): Counter<T> {
  const existing = metricsRegistry.getSingleMetric(name);
  if (existing) return existing as Counter<T>;
  return new client.Counter({
    name,
    help,
    labelNames: labelNames as T[],
    registers: [metricsRegistry],
  });
}

function getOrCreateHistogram<T extends string>(
  name: string,
  help: string,
  labelNames: readonly T[] = [] as readonly T[],
  buckets: number[]
): Histogram<T> {
  const existing = metricsRegistry.getSingleMetric(name);
  if (existing) return existing as Histogram<T>;
  return new client.Histogram({
    name,
    help,
    labelNames: labelNames as T[],
    buckets,
    registers: [metricsRegistry],
  });
}

// =============================================================================
// HTTP Metrics
// =============================================================================

export const httpRequestsTotal = getOrCreateCounter(
  "http_requests_total",
  "Total number of HTTP requests",
  ["route", "method", "status"] as const
);

export const httpRequestDurationMs = getOrCreateHistogram(
  "http_request_duration_ms",
  "HTTP request duration in milliseconds",
  ["route", "method"] as const,
  [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
);

// =============================================================================
// AI Chat Streaming Metrics
// =============================================================================

export const aiChatStreamDurationMs = getOrCreateHistogram(
  "ai_chat_stream_duration_ms",
  "AI chat stream duration in milliseconds (from response_started to stream_closed)",
  [] as const,
  [100, 500, 1000, 2500, 5000, 10000, 30000, 60000]
);

// =============================================================================
// AI LLM Call Metrics
// =============================================================================

export const aiLlmCallDurationMs = getOrCreateHistogram(
  "ai_llm_call_duration_ms",
  "AI LLM call duration in milliseconds",
  ["provider", "model_class"] as const,
  [100, 500, 1000, 2500, 5000, 10000, 30000, 60000]
);

export const aiLlmTokensTotal = getOrCreateCounter(
  "ai_llm_tokens_total",
  "Total tokens used in LLM calls",
  ["provider", "model_class"] as const
);

export const aiLlmCostUsdTotal = getOrCreateCounter(
  "ai_llm_cost_usd_total",
  "Total cost in USD for LLM calls",
  ["provider", "model_class"] as const
);

// =============================================================================
// AI LLM Error Metrics (alertable)
// =============================================================================

/**
 * Re-export AiExecutionErrorCode for metrics consumers.
 * Per ERROR_NORMALIZATION_ONCE: metrics receives pre-normalized codes, no introspection.
 */
export type { AiExecutionErrorCode };

export const aiLlmErrorsTotal = getOrCreateCounter(
  "ai_llm_errors_total",
  "Total LLM call errors by type",
  ["provider", "code", "model_class"] as const
);

// =============================================================================
// Public API Metrics
// =============================================================================

export const publicRateLimitExceededTotal = getOrCreateCounter(
  "public_rate_limit_exceeded_total",
  "Public API rate limit violations (aggregated, no PII)",
  ["route", "env"] as const
);

// =============================================================================
// Billing Metrics (alertable)
// =============================================================================

export const billingMissingCostDeferredTotal = getOrCreateCounter(
  "billing_missing_cost_deferred_total",
  "Usage facts deferred due to missing cost (callback expected)",
  ["source_system"] as const
);

export const billingInvariantViolationTotal = getOrCreateCounter(
  "billing_invariant_violation_total",
  "Billing invariant violations by type",
  ["type"] as const
);

export const appBuildInfo = getOrCreateGauge(
  "app_build_info",
  "Build metadata (version, commit SHA) — updated at runtime from APP_BUILD_SHA",
  ["version", "commit_sha"] as const
);

export function setBuildInfo(version: string, commitSha: string) {
  appBuildInfo.labels({ version, commit_sha: commitSha }).set(1);
}

// =============================================================================
// BYO-AI Auth Metrics (alertable — critical auth path)
// =============================================================================

export const byoAuthTotal = getOrCreateCounter(
  "byo_auth_total",
  "BYO-AI auth flow outcomes (device code + token exchange)",
  ["route", "outcome", "error_code"] as const
);

export const byoAuthDurationMs = getOrCreateHistogram(
  "byo_auth_duration_ms",
  "BYO-AI auth flow latency",
  ["route"] as const,
  [100, 500, 1000, 2000, 5000, 10000, 30000]
);

// =============================================================================
// Helpers
// =============================================================================

/**
 * Map HTTP status code to bucket for low-cardinality label.
 * Returns '2xx', '4xx', or '5xx'.
 */
export function statusBucket(status: number): "2xx" | "4xx" | "5xx" {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 400 && status < 500) return "4xx";
  return "5xx";
}
