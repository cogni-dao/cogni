// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/temporal`
 * Purpose: Temporal adapter exports.
 * Scope: Re-exports Temporal schedule control and read-only health adapters. Does not contain implementations.
 * Invariants: Named exports only
 * Side-effects: none
 * Links: ScheduleControlPort, docs/spec/scheduler.md
 * @public
 */

export {
  TemporalScheduleControlAdapter,
  type TemporalScheduleControlConfig,
} from "./schedule-control.adapter";
export {
  type AppVersionIdentity,
  assessPollers,
  inspectSharedTemporalHealth,
  isValidAppIdentity,
  type PollerHealth,
  parseWorkerIdentity,
  type SchedulerWorkerVersionIdentity,
  type SharedTemporalHealth,
  type SharedTemporalHealthConfig,
  type SharedTemporalHealthDeps,
  type SharedTemporalHealthReason,
  type SharedTemporalTaskType,
  TEMPORAL_POLLER_MAX_AGE_MS,
  workerPollerIdentity,
} from "./shared-temporal-health.adapter";
export {
  type ExpectedTemporalSchedule,
  inspectSharedTemporalScheduleHealth,
  type LatestDueExecutionHealth,
  type SharedTemporalScheduleDriftReason,
  type SharedTemporalScheduleHealth,
  type SharedTemporalScheduleHealthDeps,
  type SharedTemporalScheduleHealthInput,
  type SharedTemporalScheduleHealthReason,
  type SharedTemporalWorkflowStatus,
  TEMPORAL_ACTION_START_GRACE_MS,
  TEMPORAL_COLLECT_EPOCH_EXECUTION_BUDGET_MS,
  TEMPORAL_GRAPH_RUN_EXECUTION_BUDGET_MS,
  TEMPORAL_HEALTH_DESCRIBE_CONCURRENCY,
  TEMPORAL_HEALTH_MAX_NAMESPACE_SCHEDULES,
  TEMPORAL_HEALTH_MAX_SCHEDULES,
  TEMPORAL_HEALTH_RECENT_CADENCE_SLOTS,
  TEMPORAL_NODE_TASK_EXECUTION_BUDGET_MS,
  TEMPORAL_SCHEDULE_INSPECTION_TIMEOUT_MS,
} from "./shared-temporal-schedule-health.adapter";
