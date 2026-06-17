// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-core`
 * Purpose: Scheduler core types and port interfaces.
 * Scope: Pure types and interfaces for scheduling domain. Does not contain implementations or I/O.
 * Invariants:
 * - FORBIDDEN: `@/`, `src/`, drizzle-orm, any I/O
 * - ALLOWED: Pure TypeScript types/interfaces only
 * Side-effects: none
 * Links: docs/spec/scheduler.md
 * @public
 */

// Job payloads (Zod schemas for producer/consumer validation)
export {
  type ExecuteScheduledRunPayload,
  ExecuteScheduledRunPayloadSchema,
  type ReconcileSchedulesPayload,
  ReconcileSchedulesPayloadSchema,
  SCHEDULER_TASK_IDS,
  type SchedulerTaskId,
} from "./payloads";
// Ports
export {
  // ScheduleUserPort + ScheduleWorkerPort
  type CreateScheduleInput,
  // ScheduleControlPort
  type CreateScheduleParams,
  // ExecutionGrantUserPort + ExecutionGrantWorkerPort
  type ExecutionGrantUserPort,
  type ExecutionGrantWorkerPort,
  // ExecutionRequestPort
  type ExecutionOutcome,
  type ExecutionRequest,
  type ExecutionRequestPort,
  GrantExpiredError,
  GrantNodeMismatchError,
  GrantNotFoundError,
  GrantRevokedError,
  GrantScopeMismatchError,
  type GraphRunRepository,
  type IdempotencyCheckResult,
  InvalidCronExpressionError,
  InvalidTimezoneError,
  isGrantExpiredError,
  isGrantNodeMismatchError,
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
  type ScheduleOverlapPolicyHint,
  type ScheduleUserPort,
  type ScheduleWorkerPort,
  type UpdateScheduleInput,
} from "./ports";
// Grant scope mint + checker (M1 grant↔node binding + M2 scope generalization)
export {
  graphExecuteScope,
  graphExecuteWildcardScope,
  nodeTaskScope,
  nodeTaskWildcardScope,
  parseNodeTaskScope,
  type ScopeCheckResult,
  validateGrantScope,
} from "./scopes";
// Services (pure orchestration — no adapters, no I/O beyond ports)
export {
  type GovernanceScheduleConfig,
  type GovernanceScheduleEntry,
  type GovernanceScheduleSyncDeps,
  type GovernanceScheduleSyncResult,
  governanceScheduleId,
  type LedgerScheduleConfig,
  syncGovernanceSchedules,
  type UpsertGovernanceScheduleRowParams,
} from "./services/syncGovernanceSchedules";
export {
  ForeignNodeScheduleError,
  isForeignNodeScheduleError,
  type NodeScheduleEntry,
  type NodeScheduleRowState,
  type NodeScheduleSyncDeps,
  type NodeScheduleSyncResult,
  type NodeScheduleTeardownDeps,
  type NodeScheduleTeardownResult,
  type NodeTaskInputEnvelope,
  nodeScheduleId,
  nodeScheduleIdPrefix,
  syncNodeSchedules,
  teardownNodeSchedules,
  type UpsertNodeScheduleRowParams,
} from "./services/syncNodeSchedules";
// Types
export {
  type ExecutionGrant,
  GRANT_SCOPE_ACTIONS,
  GRAPH_RUN_KINDS,
  GRAPH_RUN_STATUSES,
  type GrantScopeAction,
  type GraphRun,
  type GraphRunKind,
  type GraphRunStatus,
  type ScheduleSpec,
} from "./types";
