// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/schedule-control`
 * Purpose: Vendor-agnostic port for schedule lifecycle control (create/update/pause/resume/delete/list).
 * Scope: Defines contract for schedule orchestration. Does not contain implementations or vendor imports.
 * Invariants:
 *   - Per CRUD_IS_TEMPORAL_AUTHORITY: CRUD endpoints control schedule lifecycle, worker never modifies schedules
 *   - Per WORKER_NEVER_CONTROLS_SCHEDULES: Worker must not depend on this port
 *   - createSchedule throws on conflict (caller-supplied scheduleId)
 *   - updateSchedule replaces schedule config in-place; throws NotFound if missing
 *   - deleteSchedule is idempotent (no-op if not found)
 *   - pause/resume are idempotent (no-op if already in target state)
 *   - describeSchedule returns config fields (cron, timezone, input) for drift detection
 * Side-effects: none (interface definition only)
 * Links: docs/spec/scheduler.md, docs/spec/temporal-patterns.md
 * @public
 */

import type { JsonValue } from "type-fest";

/**
 * Parameters for creating a schedule.
 * The scheduleId is caller-supplied (matches DB UUID).
 */
/**
 * Overlap policy for scheduled workflows.
 * Maps 1:1 to Temporal ScheduleOverlapPolicy values.
 */
export type ScheduleOverlapPolicyHint = "skip" | "buffer_one" | "allow_all";

export interface CreateScheduleParams {
  /** Temporal schedule ID (caller-supplied) */
  readonly scheduleId: string;
  /** Originating node ID from repo-spec. Stored in workflow args for execution routing. */
  readonly nodeId: string;
  /**
   * DB schedule UUID for schedules that have a row in `schedules`.
   * Set null/undefined only for legacy Temporal-only schedules.
   */
  readonly dbScheduleId?: string | null;
  /** User ID of the schedule owner — written as requestedBy on produced runs. */
  readonly ownerUserId: string;
  /** Cron expression (5-field) */
  readonly cron: string;
  /** IANA timezone */
  readonly timezone: string;
  /** Graph ID to execute */
  readonly graphId: string;
  /** Execution grant ID for authorization */
  readonly executionGrantId: string;
  /** Graph input payload (JSON-serializable) */
  readonly input: JsonValue;
  /** Overlap policy hint. Default: "buffer_one" for tenant schedules. Governance sync passes "skip". */
  readonly overlapPolicy?: ScheduleOverlapPolicyHint;
  /** Catchup window in milliseconds. Default: 60_000 (1m). Governance passes 0. */
  readonly catchupWindowMs?: number;
  /** Workflow type to start (default: GraphRunWorkflow) */
  readonly workflowType?: string;
  /** Task queue override (default: uses adapter's configured queue) */
  readonly taskQueueOverride?: string;
}

/**
 * Schedule description returned by describeSchedule.
 * Dates are ISO strings for serialization safety.
 */
export interface ScheduleDescription {
  /** Schedule ID */
  readonly scheduleId: string;
  /** Originating node ID from the Schedule action args, when declared. */
  readonly nodeId?: string | null;
  /** Next scheduled run time (ISO string), null if paused/none */
  readonly nextRunAtIso: string | null;
  /** Last run time (ISO string), null if never run */
  readonly lastRunAtIso: string | null;
  /** Whether schedule is paused */
  readonly isPaused: boolean;
  /** Current cron expression, null if unavailable */
  readonly cron: string | null;
  /** Current IANA timezone, null if unavailable */
  readonly timezone: string | null;
  /** Current graph input payload, null if unavailable */
  readonly input: JsonValue | null;
  /** DB schedule UUID from workflow args, null if Temporal-only (legacy) */
  readonly dbScheduleId: string | null;
  /** Workflow ID started by the most recent Schedule action, when one exists. */
  readonly lastWorkflowId?: string | null;
  /** First execution Run ID started by the most recent Schedule action. */
  readonly lastWorkflowRunId?: string | null;
  /** Current terminal/running state of the most recent Schedule action's Workflow chain. */
  readonly lastWorkflowStatus?:
    | "RUNNING"
    | "COMPLETED"
    | "FAILED"
    | "CANCELLED"
    | "TERMINATED"
    | "CONTINUED_AS_NEW"
    | "TIMED_OUT"
    | "UNKNOWN"
    | null;
  /**
   * Current task queue of the schedule's startWorkflow action, null/absent when the
   * adapter can't read it. Enables queue-migration drift detection (bug.5023): moving
   * a schedule to a per-node queue must be seen as changed, or the schedule keeps firing
   * on the old (now unpolled) queue.
   */
  readonly taskQueue?: string | null;
}

/**
 * Error thrown when schedule control backend is unavailable.
 * Maps to: connection errors, timeouts, service unavailable.
 * CRUD layer should return 503 and rollback DB changes.
 */
export class ScheduleControlUnavailableError extends Error {
  constructor(
    public readonly operation: string,
    public readonly cause?: Error
  ) {
    super(
      `Schedule control unavailable during ${operation}: ${cause?.message ?? "unknown error"}`
    );
    this.name = "ScheduleControlUnavailableError";
  }
}

/**
 * Error thrown when schedule already exists (createSchedule conflict).
 * CRUD layer should rollback DB changes.
 */
export class ScheduleControlConflictError extends Error {
  constructor(public readonly scheduleId: string) {
    super(`Schedule already exists: ${scheduleId}`);
    this.name = "ScheduleControlConflictError";
  }
}

/**
 * Error thrown when schedule not found (pause/resume on non-existent schedule).
 * Note: deleteSchedule is idempotent and does NOT throw this error.
 */
export class ScheduleControlNotFoundError extends Error {
  constructor(public readonly scheduleId: string) {
    super(`Schedule not found: ${scheduleId}`);
    this.name = "ScheduleControlNotFoundError";
  }
}

export function isScheduleControlUnavailableError(
  error: unknown
): error is ScheduleControlUnavailableError {
  return (
    error instanceof Error && error.name === "ScheduleControlUnavailableError"
  );
}

export function isScheduleControlConflictError(
  error: unknown
): error is ScheduleControlConflictError {
  return (
    error instanceof Error && error.name === "ScheduleControlConflictError"
  );
}

export function isScheduleControlNotFoundError(
  error: unknown
): error is ScheduleControlNotFoundError {
  return (
    error instanceof Error && error.name === "ScheduleControlNotFoundError"
  );
}

/**
 * Vendor-agnostic port for schedule lifecycle control.
 *
 * Per CRUD_IS_TEMPORAL_AUTHORITY: This port is used ONLY by CRUD endpoints.
 * Per WORKER_NEVER_CONTROLS_SCHEDULES: Worker service must NOT depend on this port.
 *
 * Idempotency semantics:
 * | Method           | Idempotent? | On Not Found                    | On Already Exists              |
 * |------------------|-------------|---------------------------------|--------------------------------|
 * | createSchedule   | No          | N/A                             | Throw ScheduleControlConflict  |
 * | updateSchedule   | Yes         | Throw ScheduleControlNotFound   | N/A (updates in place)         |
 * | pauseSchedule    | Yes         | Throw ScheduleControlNotFound   | No-op if already paused        |
 * | resumeSchedule   | Yes         | Throw ScheduleControlNotFound   | No-op if already running       |
 * | deleteSchedule   | Yes         | No-op (success)                 | N/A                            |
 * | triggerSchedule  | Yes         | Throw ScheduleControlNotFound   | N/A (triggers immediately)     |
 * | describeSchedule | Yes         | Return null                     | N/A                            |
 */
export interface ScheduleControlPort {
  /**
   * Creates a new schedule.
   *
   * @param params - Schedule configuration (scheduleId is caller-supplied)
   * @throws ScheduleControlConflictError if schedule already exists
   * @throws ScheduleControlUnavailableError if backend unavailable
   */
  createSchedule(params: CreateScheduleParams): Promise<void>;

  /**
   * Updates an existing schedule's configuration (spec, action, policies).
   * Used by governance sync to apply config changes without delete+recreate.
   *
   * @param scheduleId - Schedule to update
   * @param params - New schedule configuration
   * @throws ScheduleControlNotFoundError if schedule doesn't exist
   * @throws ScheduleControlUnavailableError if backend unavailable
   */
  updateSchedule(
    scheduleId: string,
    params: CreateScheduleParams
  ): Promise<void>;

  /**
   * Pauses a schedule (stops future runs).
   * Idempotent: no-op if already paused.
   *
   * @param scheduleId - Schedule to pause
   * @throws ScheduleControlNotFoundError if schedule doesn't exist
   * @throws ScheduleControlUnavailableError if backend unavailable
   */
  pauseSchedule(scheduleId: string): Promise<void>;

  /**
   * Resumes a paused schedule.
   * Idempotent: no-op if already running.
   *
   * @param scheduleId - Schedule to resume
   * @throws ScheduleControlNotFoundError if schedule doesn't exist
   * @throws ScheduleControlUnavailableError if backend unavailable
   */
  resumeSchedule(scheduleId: string): Promise<void>;

  /**
   * Deletes a schedule.
   * Idempotent: no-op if schedule doesn't exist.
   *
   * @param scheduleId - Schedule to delete
   * @throws ScheduleControlUnavailableError if backend unavailable
   */
  deleteSchedule(scheduleId: string): Promise<void>;

  /**
   * Describes a schedule's current state.
   *
   * @param scheduleId - Schedule to describe
   * @returns Schedule description or null if not found
   * @throws ScheduleControlUnavailableError if backend unavailable
   */
  describeSchedule(scheduleId: string): Promise<ScheduleDescription | null>;

  /**
   * Triggers an immediate run of a schedule.
   * Uses the schedule's existing config (workflow type, input, task queue).
   *
   * @param scheduleId - Schedule to trigger
   * @throws ScheduleControlNotFoundError if schedule doesn't exist
   * @throws ScheduleControlUnavailableError if backend unavailable
   */
  triggerSchedule(scheduleId: string): Promise<void>;

  /**
   * Lists schedule IDs matching a prefix.
   * Used by governance sync to discover existing governance: schedules.
   *
   * @param prefix - Prefix to filter by (e.g., "governance:")
   * @param limit - Optional fail-safe maximum; stops listing once reached
   * @returns Array of matching schedule IDs
   * @throws ScheduleControlUnavailableError if backend unavailable
   */
  listScheduleIds(prefix: string, limit?: number): Promise<string[]>;
}
