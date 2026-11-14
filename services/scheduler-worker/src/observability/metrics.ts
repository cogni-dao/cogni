// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/observability/metrics`
 * Purpose: Prometheus metrics for Temporal worker health and activity performance.
 * Scope: Define and export worker-specific metrics + shared registry. Does not serve HTTP.
 * Invariants: All metrics use `temporal_` or `ledger_` prefix for namespace isolation.
 * Side-effects: Registers default Node.js metrics (heap, RSS, GC) on import.
 * Links: https://node-template.cognidao.org/knowledge/observability-logging-contract, src/health.ts (/metrics endpoint)
 * @public
 */

import client from "prom-client";

// Shared registry — collectDefaultMetrics populates process/heap/GC metrics
export const metricsRegistry = new client.Registry();
client.collectDefaultMetrics({ register: metricsRegistry });

/**
 * Histogram: Activity execution duration in milliseconds.
 * Labels: activity (name), status (success|error)
 */
export const activityDurationMs = new client.Histogram({
  name: "temporal_activity_duration_ms",
  help: "Duration of Temporal activity executions in milliseconds",
  labelNames: ["activity", "status"] as const,
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
  registers: [metricsRegistry],
});

/**
 * Counter: Total activity errors.
 * Labels: activity (name), error_type (retryable|non_retryable|unknown)
 */
export const activityErrorsTotal = new client.Counter({
  name: "temporal_activity_errors_total",
  help: "Total number of Temporal activity errors",
  labelNames: ["activity", "error_type"] as const,
  registers: [metricsRegistry],
});

/**
 * Gauge: Worker info (always 1 when worker is running).
 * Labels: task_queue
 * Scrape failure = worker down (deadman pattern).
 */
export const workerInfo = new client.Gauge({
  name: "temporal_worker_info",
  help: "Temporal worker info gauge (1 = running)",
  labelNames: ["task_queue"] as const,
  registers: [metricsRegistry],
});

/**
 * Gauge: Per-node HTTP reachability from the worker (1 = /readyz responded 2xx).
 * Sampled at boot. Absent or 0 = the node was not reachable at boot time — the
 * worker still starts and will attempt HTTP calls per-activity. Alert on this
 * gauge at the Prometheus layer, do NOT gate worker boot on it.
 * Per task.0280 phase 2 (QUEUE_PER_NODE_ISOLATION).
 */
export const schedulerWorkerNodeReachable = new client.Gauge({
  name: "scheduler_worker_node_reachable_at_boot",
  help: "1 if node-app /readyz responded 2xx at worker boot, 0 otherwise",
  labelNames: ["node_id"] as const,
  registers: [metricsRegistry],
});
