// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/metrics`
 * Purpose: Factory for MetricsCapability - bridges ai-tools capability interface to MimirMetricsAdapter.
 * Scope: Creates MetricsCapability from server environment. Does not implement transport.
 * Invariants:
 *   - NO_SECRETS_IN_CONTEXT: Prometheus credentials resolved from env, never passed to tools
 *   - GOVERNED_METRICS: Only template-based queries via MimirMetricsAdapter.queryTemplate
 * Side-effects: none (factory only)
 * Links: Called by bootstrap container; consumed by ai-tools metrics-query tool.
 *        Uses PROMETHEUS_REMOTE_WRITE_URL or PROMETHEUS_QUERY_URL + USERNAME/PASSWORD.
 * @internal
 */

import type { MetricsCapability } from "@cogni/ai-tools";

import { MimirMetricsAdapter } from "@/adapters/server";
import { FakeMetricsAdapter } from "@/adapters/test";
import type { ServerEnv } from "@/shared/env";

/**
 * Stub MetricsCapability that throws when not configured.
 * Used when Prometheus query URL cannot be derived.
 */
export const stubMetricsCapability: MetricsCapability = {
  queryTemplate: async () => {
    throw new Error(
      "MetricsCapability not configured. Set PROMETHEUS_QUERY_URL (or PROMETHEUS_REMOTE_WRITE_URL " +
        "ending in /api/prom/push) + PROMETHEUS_READ_USERNAME + PROMETHEUS_READ_PASSWORD."
    );
  },
};

/**
 * Derive Prometheus query URL from config.
 * - If PROMETHEUS_QUERY_URL set, use it directly
 * - If PROMETHEUS_REMOTE_WRITE_URL ends with /api/prom/push, derive by stripping /push
 * - Otherwise return undefined (invalid config)
 */
export function derivePrometheusQueryUrl(env: ServerEnv): string | undefined {
  if (env.PROMETHEUS_QUERY_URL) return env.PROMETHEUS_QUERY_URL;

  const writeUrl = env.PROMETHEUS_REMOTE_WRITE_URL;
  if (writeUrl?.endsWith("/api/prom/push")) {
    return writeUrl.slice(0, -"/push".length); // → .../api/prom
  }
  return undefined;
}

/**
 * Create MetricsCapability from server environment.
 * Uses Prometheus configuration (PROMETHEUS_REMOTE_WRITE_URL or PROMETHEUS_QUERY_URL).
 *
 * - APP_ENV=test: FakeMetricsAdapter
 * - Configured: MimirMetricsAdapter (real Prometheus HTTP API)
 * - Not configured: stub that throws on use
 *
 * @param env - Server environment with Prometheus configuration
 * @returns MetricsCapability backed by appropriate adapter
 */
export function createMetricsCapability(env: ServerEnv): MetricsCapability {
  // Test mode only: use FakeMetricsAdapter
  if (env.isTestMode) {
    const fake = new FakeMetricsAdapter();
    return { queryTemplate: (p) => fake.queryTemplate(p) };
  }

  const queryUrl = derivePrometheusQueryUrl(env);
  const username = env.PROMETHEUS_READ_USERNAME;
  const password = env.PROMETHEUS_READ_PASSWORD;

  // Not configured: stub that throws on use
  if (!queryUrl || !username || !password) {
    return stubMetricsCapability;
  }

  // Configured: use real Prometheus HTTP API adapter (read-only credentials)
  const adapter = new MimirMetricsAdapter({
    url: queryUrl,
    username,
    password,
    timeoutMs: env.ANALYTICS_QUERY_TIMEOUT_MS,
  });
  return { queryTemplate: (p) => adapter.queryTemplate(p) };
}
