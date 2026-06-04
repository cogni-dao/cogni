// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-sync-service/metrics`
 * Purpose: Prometheus metrics registry + knowledge-sync counters/gauges.
 * Scope: Metric definitions + registry. Does not collect or expose (health.ts serves /metrics).
 * Invariants: One registry per process; metrics labelled by node + remote.
 * Side-effects: Registers default Node.js metrics on import.
 * @internal
 */

import { Counter, collectDefaultMetrics, Gauge, Registry } from "prom-client";

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const pushTotal = new Counter({
  name: "knowledge_sync_push_total",
  help: "Total dolt_push reconciliation attempts by outcome",
  labelNames: ["node", "outcome"] as const,
  registers: [metricsRegistry],
});

export const pushDurationMs = new Gauge({
  name: "knowledge_sync_push_duration_ms",
  help: "Duration of the last dolt_push attempt in milliseconds",
  labelNames: ["node"] as const,
  registers: [metricsRegistry],
});

export const lastPushSuccessTimestamp = new Gauge({
  name: "knowledge_sync_last_push_success_timestamp_seconds",
  help: "Unix timestamp of the last successful dolt_push",
  labelNames: ["node"] as const,
  registers: [metricsRegistry],
});

export const mirrorEnabled = new Gauge({
  name: "knowledge_sync_mirror_enabled",
  help: "1 when the DoltHub mirror is configured (DOLTGRES_URL + DOLTHUB_REMOTE_URL), else 0",
  labelNames: ["node"] as const,
  registers: [metricsRegistry],
});
