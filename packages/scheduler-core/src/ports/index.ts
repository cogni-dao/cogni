// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-core/ports`
 * Purpose: Scheduling ports barrel export.
 * Scope: Re-exports all scheduling port interfaces and errors. Does not contain implementations.
 * Invariants: All exports are interfaces or error classes only.
 * Side-effects: none
 * Links: docs/spec/scheduler.md
 * @public
 */

export {
  type ExecutionGrant,
  type ExecutionGrantUserPort,
  type ExecutionGrantWorkerPort,
  GrantExpiredError,
  GrantNodeMismatchError,
  GrantNotFoundError,
  GrantRevokedError,
  GrantScopeMismatchError,
  isGrantExpiredError,
  isGrantNodeMismatchError,
  isGrantNotFoundError,
  isGrantRevokedError,
  isGrantScopeMismatchError,
} from "./execution-grant.port";
export type {
  ExecutionOutcome,
  ExecutionRequest,
  ExecutionRequestPort,
  IdempotencyCheckResult,
} from "./execution-request.port";
export {
  type CreateScheduleParams,
  isScheduleControlConflictError,
  isScheduleControlNotFoundError,
  isScheduleControlUnavailableError,
  ScheduleControlConflictError,
  ScheduleControlNotFoundError,
  type ScheduleControlPort,
  ScheduleControlUnavailableError,
  type ScheduleDescription,
  type ScheduleOverlapPolicyHint,
} from "./schedule-control.port";
export {
  type CreateScheduleInput,
  InvalidCronExpressionError,
  InvalidTimezoneError,
  isInvalidCronExpressionError,
  isInvalidTimezoneError,
  isScheduleAccessDeniedError,
  isScheduleNotFoundError,
  ScheduleAccessDeniedError,
  ScheduleNotFoundError,
  type ScheduleSpec,
  type ScheduleUserPort,
  type ScheduleWorkerPort,
  type UpdateScheduleInput,
} from "./schedule-manager.port";
export type {
  GraphRun,
  GraphRunKind,
  GraphRunRepository,
  GraphRunStatus,
} from "./schedule-run.port";
