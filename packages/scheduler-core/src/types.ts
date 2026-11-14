// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-core/types`
 * Purpose: Shared scheduling type definitions and constants (logic-free).
 * Scope: Defines ExecutionGrant, ScheduleSpec, GraphRun types and status enums. Does not contain logic.
 * Invariants:
 * - ONLY exports: enums (as const arrays), literal union types, and interfaces
 * - FORBIDDEN: functions, computations, validation logic, or business rules
 * - Grant scopes constrain which graphIds can be executed (GRANT_SCOPES_CONSTRAIN_GRAPHS)
 * - Per SINGLE_RUN_LEDGER: GraphRun is the canonical run record type for all execution types
 * Side-effects: none (constants and types only)
 * Links: https://node-template.cognidao.org/knowledge/scheduled-run-grant-contract, https://node-template.cognidao.org/knowledge/graph-run-launch-contract
 * @public
 */

// Import from db-schema (source of truth for DB enums)
import {
  GRAPH_RUN_KINDS as _GRAPH_RUN_KINDS,
  GRAPH_RUN_STATUSES as _GRAPH_RUN_STATUSES,
  type GraphRunKind as _GraphRunKind,
  type GraphRunStatus as _GraphRunStatus,
} from "@cogni/db-schema/scheduling";

// Re-export graph run types
export const GRAPH_RUN_STATUSES = _GRAPH_RUN_STATUSES;
export type GraphRunStatus = _GraphRunStatus;
export const GRAPH_RUN_KINDS = _GRAPH_RUN_KINDS;
export type GraphRunKind = _GraphRunKind;

/**
 * Grant scope action types.
 * P0: Only graph:execute is supported.
 */
export const GRANT_SCOPE_ACTIONS = ["graph:execute"] as const;

export type GrantScopeAction = (typeof GRANT_SCOPE_ACTIONS)[number];

/**
 * Execution grant - durable authorization for scheduled graph execution.
 * Per GRANT_NOT_SESSION: Scheduled runs authenticate via grants, not user sessions.
 * Note: virtualKeyId is resolved at runtime via AccountService (not stored in grant).
 */
export interface ExecutionGrant {
  readonly id: string;
  readonly userId: string;
  readonly billingAccountId: string;
  /** Scopes in format "graph:execute:{graphId}" or "graph:execute:*" for wildcard */
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Schedule specification - defines a recurring graph execution.
 */
export interface ScheduleSpec {
  readonly id: string;
  readonly ownerUserId: string;
  readonly executionGrantId: string;
  readonly graphId: string;
  readonly input: unknown;
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly nextRunAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Graph run record — single canonical run ledger entry.
 * Per SINGLE_RUN_LEDGER: same shape for API, scheduled, and webhook runs.
 */
export interface GraphRun {
  readonly id: string;
  /** Schedule FK — null for non-scheduled runs */
  readonly scheduleId: string | null;
  readonly runId: string;
  readonly graphId: string | null;
  readonly runKind: GraphRunKind | null;
  readonly triggerSource: string | null;
  readonly triggerRef: string | null;
  readonly requestedBy: string | null;
  readonly scheduledFor: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly status: GraphRunStatus;
  readonly attemptCount: number;
  readonly langfuseTraceId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** Thread state key for conversation correlation — null for headless runs */
  readonly stateKey: string | null;
}
