// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/schedule-manager`
 * Purpose: Schedule port interfaces split by trust boundary (user vs worker).
 * Scope: Defines contracts for schedule lifecycle. Does not contain implementations.
 * Invariants:
 * - Per CRUD_IS_TEMPORAL_AUTHORITY: createSchedule creates grant + DB + scheduleControl
 * - Per SCHEDULER_SPEC.md: next_run_at is cache-only (Temporal is authoritative)
 * - Schedule access scoped to owner (callerUserId)
 * Side-effects: none (interface definition only)
 * Links: docs/spec/scheduler.md, types/scheduling.ts, DrizzleScheduleManagerAdapter
 * @public
 */

import type { ActorId, UserId } from "@cogni/ids";
import type { ScheduleSpec } from "../types";

// Re-export type for adapter convenience
export type { ScheduleSpec } from "../types";

/**
 * Port-level error thrown when schedule is not found.
 */
export class ScheduleNotFoundError extends Error {
  constructor(public readonly scheduleId: string) {
    super(`Schedule not found: ${scheduleId}`);
    this.name = "ScheduleNotFoundError";
  }
}

/**
 * Port-level error thrown when caller is not authorized to access schedule.
 */
export class ScheduleAccessDeniedError extends Error {
  constructor(
    public readonly scheduleId: string,
    public readonly callerUserId: string
  ) {
    super(`Access denied to schedule ${scheduleId} for user ${callerUserId}`);
    this.name = "ScheduleAccessDeniedError";
  }
}

/**
 * Port-level error thrown when cron expression is invalid.
 */
export class InvalidCronExpressionError extends Error {
  constructor(
    public readonly cron: string,
    public readonly reason: string
  ) {
    super(`Invalid cron expression "${cron}": ${reason}`);
    this.name = "InvalidCronExpressionError";
  }
}

/**
 * Port-level error thrown when timezone is invalid.
 */
export class InvalidTimezoneError extends Error {
  constructor(public readonly timezone: string) {
    super(`Invalid timezone: ${timezone}`);
    this.name = "InvalidTimezoneError";
  }
}

export function isScheduleNotFoundError(
  error: unknown
): error is ScheduleNotFoundError {
  return error instanceof Error && error.name === "ScheduleNotFoundError";
}

export function isScheduleAccessDeniedError(
  error: unknown
): error is ScheduleAccessDeniedError {
  return error instanceof Error && error.name === "ScheduleAccessDeniedError";
}

export function isInvalidCronExpressionError(
  error: unknown
): error is InvalidCronExpressionError {
  return error instanceof Error && error.name === "InvalidCronExpressionError";
}

export function isInvalidTimezoneError(
  error: unknown
): error is InvalidTimezoneError {
  return error instanceof Error && error.name === "InvalidTimezoneError";
}

export interface CreateScheduleInput {
  /** Originating node ID from repo-spec. Routes execution to correct node. */
  nodeId: string;
  /**
   * Graph ID to execute. Set for a graph schedule (mutually exclusive with route).
   * For a NodeTask schedule the adapter synthesizes `task:<route>` instead.
   */
  graphId?: string;
  /**
   * Node-relative route for a NodeTask http-dispatch schedule (mutually exclusive
   * with graphId). When set, the adapter routes to NodeTaskWorkflow and grants
   * `task:dispatch:<nodeId>:<route>` scope.
   */
  route?: string;
  input: unknown;
  cron: string;
  timezone: string;
}

export interface UpdateScheduleInput {
  input?: unknown;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
}

/**
 * User-facing schedule CRUD. All methods require callerUserId for RLS scoping.
 * Constructed with appDb (RLS enforced).
 * Function properties (not methods) for contravariant param checking on branded types.
 */
export interface ScheduleUserPort {
  /**
   * Creates schedule with grant and scheduleControl.
   * Per CRUD_IS_TEMPORAL_AUTHORITY: grant → DB → scheduleControl.
   */
  createSchedule: (
    callerUserId: UserId,
    billingAccountId: string,
    input: CreateScheduleInput
  ) => Promise<ScheduleSpec>;

  /** Lists schedules owned by caller. */
  listSchedules: (callerUserId: UserId) => Promise<readonly ScheduleSpec[]>;

  /** Gets schedule by ID, scoped to caller via RLS. */
  getSchedule: (
    callerUserId: UserId,
    scheduleId: string
  ) => Promise<ScheduleSpec | null>;

  /**
   * Updates schedule. Recomputes next_run_at if cron/timezone/enabled changed.
   * @throws ScheduleNotFoundError, ScheduleAccessDeniedError
   */
  updateSchedule: (
    callerUserId: UserId,
    scheduleId: string,
    patch: UpdateScheduleInput
  ) => Promise<ScheduleSpec>;

  /**
   * Deletes schedule and revokes associated grant.
   * @throws ScheduleNotFoundError, ScheduleAccessDeniedError
   */
  deleteSchedule: (callerUserId: UserId, scheduleId: string) => Promise<void>;
}

/**
 * Worker-only schedule operations (Temporal worker, reconciler).
 * actorId = system actor or grant userId for audit trail.
 * Constructed with serviceDb (BYPASSRLS).
 * Function properties (not methods) for contravariant param checking on branded types.
 */
export interface ScheduleWorkerPort {
  /** Gets schedule by ID for worker processing. */
  getScheduleForWorker: (
    actorId: ActorId,
    scheduleId: string
  ) => Promise<ScheduleSpec | null>;

  /** Updates next_run_at after execution (used by worker). */
  updateNextRunAt: (
    actorId: ActorId,
    scheduleId: string,
    nextRunAt: Date
  ) => Promise<void>;

  /** Updates last_run_at when execution starts (used by worker). */
  updateLastRunAt: (
    actorId: ActorId,
    scheduleId: string,
    lastRunAt: Date
  ) => Promise<void>;

  /** Finds enabled schedules with stale next_run_at (used by reconciler). */
  findStaleSchedules: (actorId: ActorId) => Promise<readonly ScheduleSpec[]>;
}
