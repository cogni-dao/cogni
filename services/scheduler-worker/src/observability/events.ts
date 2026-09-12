// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/observability/events`
 * Purpose: Event name registry for structured logging — prevents ad-hoc strings and schema drift.
 * Scope: Define valid worker event names as const registry. Does not define full payload schemas.
 * Invariants: All event names registered here; logWorkerEvent() enforces `event` field presence.
 * Side-effects: none
 * Links: docs/spec/observability.md, src/shared/observability/events/index.ts (main app pattern)
 * @public
 */

export const WORKER_EVENT_NAMES = {
  // Lifecycle — main.ts, worker.ts boot/shutdown
  LIFECYCLE_STARTING: "worker.lifecycle.starting",
  LIFECYCLE_READY: "worker.lifecycle.ready",
  LIFECYCLE_SHUTDOWN: "worker.lifecycle.shutdown",
  LIFECYCLE_SHUTDOWN_COMPLETE: "worker.lifecycle.shutdown_complete",
  LIFECYCLE_FATAL: "worker.lifecycle.fatal",

  // Scheduler activities — activities/index.ts
  ACTIVITY_GRANT_VALIDATED: "worker.activity.grant_validated",
  ACTIVITY_RUN_CREATED: "worker.activity.run_created",
  ACTIVITY_GRAPH_EXECUTING: "worker.activity.graph_executing",
  ACTIVITY_GRAPH_COMPLETED: "worker.activity.graph_completed",
  ACTIVITY_GRAPH_ERROR: "worker.activity.graph_error",
  ACTIVITY_RUN_UPDATED: "worker.activity.run_updated",
  ACTIVITY_SWEEP_RESULT: "worker.activity.sweep_result",

  // Ledger activities — activities/ledger.ts
  LEDGER_EPOCH_ENSURED: "worker.ledger.epoch_ensured",
  LEDGER_EPOCH_CREATED: "worker.ledger.epoch_created",
  LEDGER_CURSOR_LOADED: "worker.ledger.cursor_loaded",
  LEDGER_COLLECTED: "worker.ledger.collected",
  LEDGER_EVENTS_INSERTED: "worker.ledger.events_inserted",
  LEDGER_CURSOR_SAVED: "worker.ledger.cursor_saved",
  LEDGER_CURATED: "worker.ledger.curated",

  // Config — container bootstrap
  CONFIG_NODE_ENDPOINTS: "worker.config.node_endpoints",
  CONFIG_WEIGHT_DRIFT: "worker.config.weight_drift",
  CONFIG_ADAPTER_SKIPPED: "worker.config.adapter_skipped",
  CONFIG_LEDGER_DISABLED: "worker.config.ledger_disabled",
  CONFIG_SOURCE_NO_ADAPTER: "worker.config.source_no_adapter",
} as const;

export type WorkerEventName =
  (typeof WORKER_EVENT_NAMES)[keyof typeof WORKER_EVENT_NAMES];
