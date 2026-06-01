// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/server`
 * Purpose: Server-only port re-exports. Symbols here transitively pull node: builtins
 *          (e.g. @cogni/scheduler-core uses node:util) and MUST NOT be imported by
 *          client components or any module reachable from the client bundle.
 * Scope: Re-exports scheduling ports from @cogni/scheduler-core. Does not contain implementations or client-safe exports.
 * Invariants: Never import this file from client components, hooks, or client barrels.
 * Side-effects: none
 * Notes: Split from @/ports (index.ts) to enforce Next.js App Router environment boundaries.
 *        See bug.0147 for rationale.
 * Links: @/ports (client-safe surface), .dependency-cruiser.cjs
 * @public
 */

// Scheduling ports - re-exported from @cogni/scheduler-core package
// @cogni/scheduler-core transitively imports node:util — server-only.
export {
  type CreateScheduleInput,
  type CreateScheduleParams,
  type ExecutionGrant,
  type ExecutionGrantUserPort,
  type ExecutionGrantWorkerPort,
  type ExecutionOutcome,
  type ExecutionRequest,
  type ExecutionRequestPort,
  GrantExpiredError,
  GrantNotFoundError,
  GrantRevokedError,
  GrantScopeMismatchError,
  type GraphRun,
  type GraphRunRepository,
  type GraphRunStatus,
  type IdempotencyCheckResult,
  InvalidCronExpressionError,
  InvalidTimezoneError,
  isGrantExpiredError,
  isGrantNotFoundError,
  isGrantRevokedError,
  isGrantScopeMismatchError,
  isInvalidCronExpressionError,
  isInvalidTimezoneError,
  isScheduleAccessDeniedError,
  isScheduleControlConflictError,
  isScheduleControlNotFoundError,
  isScheduleControlUnavailableError,
  isScheduleNotFoundError,
  ScheduleAccessDeniedError,
  ScheduleControlConflictError,
  ScheduleControlNotFoundError,
  type ScheduleControlPort,
  ScheduleControlUnavailableError,
  type ScheduleDescription,
  ScheduleNotFoundError,
  type ScheduleSpec,
  type ScheduleUserPort,
  type ScheduleWorkerPort,
  type UpdateScheduleInput,
} from "@cogni/scheduler-core";
