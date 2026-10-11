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
} from "./shared-temporal-health.adapter";
