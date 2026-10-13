// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/execution-request`
 * Purpose: Port interface for execution request idempotency.
 * Scope: Defines contract for idempotent graph execution via internal API. Does not contain implementations.
 * Invariants:
 *   - Per EXECUTION_IDEMPOTENCY_PERSISTED: Persists idempotency key → {ok, runId, traceId, errorCode}
 *   - Stores BOTH success and error outcomes - retries return cached outcome
 *   - idempotencyKey uniqueness enforced at DB level (primary key)
 *   - requestHash mismatch detection for payload integrity
 * Side-effects: none (interface definition only)
 * Links: docs/spec/scheduler.md, execution_requests table
 * @public
 */

import type { AiExecutionErrorCode } from "@cogni/ai-core";

/**
 * Stored execution request record.
 * Per SCHEDULER_SPEC.md: correctness layer for slot deduplication.
 * Stores both success and error outcomes for replay.
 * Lifecycle: pending (ok=null) → finalized (ok=true/false)
 */
export interface ExecutionRequest {
  /** Idempotency key (e.g., `scheduleId:TemporalScheduledStartTime`) */
  readonly idempotencyKey: string;
  /** SHA256 hash of graph identity plus exact request bytes */
  readonly requestHash: string;
  /** GraphExecutorPort runId */
  readonly runId: string;
  /** Langfuse trace ID (null if Langfuse not configured) */
  readonly traceId: string | null;
  /** Execution outcome: true = success, false = error, null = pending */
  readonly ok: boolean | null;
  /** AiExecutionErrorCode if ok=false, null if ok=true or pending */
  readonly errorCode: AiExecutionErrorCode | null;
}

/**
 * Result of checking idempotency.
 * - new: No record exists, caller should create pending and proceed
 * - stale: Record exists with ok=null and an expired lease; caller may attempt re-claim
 * - pending: Record exists with ok=null and a live lease; retry should wait
 * - cached: Record exists with ok!=null, return cached result
 * - mismatch: Record exists but requestHash differs, reject with 422
 */
export type IdempotencyCheckResult =
  | { status: "new" }
  | { status: "stale"; request: ExecutionRequest }
  | { status: "pending"; request: ExecutionRequest }
  | { status: "cached"; request: ExecutionRequest }
  | { status: "mismatch"; existingHash: string; providedHash: string };

/**
 * Outcome of graph execution to be persisted.
 */
export interface ExecutionOutcome {
  /** Execution succeeded */
  readonly ok: boolean;
  /** AiExecutionErrorCode if ok=false */
  readonly errorCode: AiExecutionErrorCode | null;
}

/**
 * Port interface for execution request idempotency.
 * Per EXECUTION_IDEMPOTENCY_PERSISTED: This is the correctness layer for slot deduplication.
 * Lifecycle: pending (ok=null) → finalized (ok=true/false)
 * - On request start: create pending row via createPendingRequest()
 * - On completion: update outcome via finalizeRequest()
 * - During execution: heartbeatRequest extends the pending lease
 * - On retry: checkIdempotency returns stale/pending/cached/mismatch
 */
export interface ExecutionRequestPort {
  /**
   * Check if an execution request already exists.
   *
   * - If idempotencyKey doesn't exist: returns { status: 'new' }
   * - If idempotencyKey exists, requestHash matches, ok=null, lease expired: returns { status: 'stale', request }
   * - If idempotencyKey exists, requestHash matches, ok=null, lease live: returns { status: 'pending', request }
   * - If idempotencyKey exists, requestHash matches, ok!=null: returns { status: 'cached', request }
   * - If idempotencyKey exists but requestHash differs: returns { status: 'mismatch' }
   *
   * @param idempotencyKey - Unique key for deduplication (e.g., `scheduleId:scheduledFor`)
   * @param requestHash - SHA256 hash of graph identity plus exact request bytes
   */
  checkIdempotency(
    idempotencyKey: string,
    requestHash: string
  ): Promise<IdempotencyCheckResult>;

  /**
   * Create a pending execution request at the start of processing.
   * Called before graph execution begins to claim the idempotency slot.
   * Graph callers provide a lease so concurrent insert and stale re-claim
   * races converge on one claimant. Omission preserves non-leased generic jobs.
   *
   * @param idempotencyKey - Unique key for deduplication
   * @param requestHash - SHA256 hash of graph identity plus exact request bytes
   * @param runId - GraphExecutorPort runId (canonical, shared with graph_runs)
   * @param traceId - Langfuse trace ID (null if not configured)
   */
  createPendingRequest(
    idempotencyKey: string,
    requestHash: string,
    runId: string,
    traceId: string | null,
    leaseExpiresAt?: string
  ): Promise<
    IdempotencyCheckResult | { status: "claimed"; request: ExecutionRequest }
  >;

  /** Extend a pending request lease while the execution node pumps the graph. */
  heartbeatRequest(
    idempotencyKey: string,
    leaseExpiresAt: string
  ): Promise<void>;

  /**
   * Finalize a pending execution request after graph execution completes.
   * Updates ok + errorCode from null (pending) to final outcome.
   * Called with BOTH success and error outcomes.
   *
   * @param idempotencyKey - Unique key for deduplication
   * @param outcome - Execution result (ok + errorCode)
   */
  finalizeRequest(
    idempotencyKey: string,
    outcome: ExecutionOutcome
  ): Promise<void>;

  /**
   * @deprecated Use createPendingRequest + finalizeRequest instead.
   * Kept for backwards compatibility during migration.
   */
  storeRequest(
    idempotencyKey: string,
    requestHash: string,
    runId: string,
    traceId: string | null,
    outcome: ExecutionOutcome
  ): Promise<void>;
}
