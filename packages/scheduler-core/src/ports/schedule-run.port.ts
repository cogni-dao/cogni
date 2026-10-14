// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/graph-run`
 * Purpose: Graph run repository port for the canonical run ledger.
 * Scope: Defines contract for run record persistence. Does not contain implementations.
 * Invariants:
 * - Per SINGLE_RUN_LEDGER: one table for all execution types (API, scheduled, webhook)
 * - UNIQUE(schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL prevents duplicate scheduled runs
 * - Used by worker activities, not by schedule CRUD adapter
 * - actorId required on all methods for RLS SET LOCAL / audit trail
 * Side-effects: none (interface definition only)
 * Links: docs/spec/scheduler.md, docs/spec/unified-graph-launch.md, DrizzleGraphRunAdapter
 * @public
 */

import type { ActorId } from "@cogni/ids";

// Re-export types for adapter convenience
export type { GraphRun, GraphRunKind, GraphRunStatus } from "../types";

// Import for local use in interface
import type { GraphRun, GraphRunKind, GraphRunStatus } from "../types";

/**
 * Graph run repository — persistence for the canonical run ledger.
 * Per SINGLE_RUN_LEDGER: handles all run types (API, scheduled, webhook).
 * Function properties (not methods) for contravariant param checking on branded types.
 */
export interface GraphRunRepository {
  /**
   * Creates a run record. Status defaults to 'pending'.
   * For scheduled runs: scheduleId + scheduledFor provide slot uniqueness.
   * For API/webhook runs: scheduleId is null.
   * @param actorId - Actor performing the operation (for RLS SET LOCAL / audit trail)
   */
  createRun: (
    actorId: ActorId,
    params: {
      runId: string;
      graphId?: string;
      runKind?: GraphRunKind;
      triggerSource?: string;
      triggerRef?: string;
      requestedBy?: string;
      /** Only for scheduled runs */
      scheduleId?: string;
      /** Only for scheduled runs */
      scheduledFor?: Date;
      /** Thread state key for conversation correlation */
      stateKey?: string;
    }
  ) => Promise<GraphRun>;

  /**
   * Marks run as started (status = 'running', sets startedAt).
   * @param actorId - Actor performing the operation (for RLS SET LOCAL / audit trail)
   */
  markRunStarted: (
    actorId: ActorId,
    runId: string,
    langfuseTraceId?: string
  ) => Promise<void>;

  /**
   * Marks run as completed with final status.
   * @param actorId - Actor performing the operation (for RLS SET LOCAL / audit trail)
   */
  markRunCompleted: (
    actorId: ActorId,
    runId: string,
    status: "success" | "error" | "timeout" | "skipped" | "cancelled",
    errorMessage?: string,
    errorCode?: string
  ) => Promise<void>;

  /**
   * Retrieves a run by its runId (correlation ID, not PK).
   * Returns null if not found.
   * @param actorId - Actor performing the operation (for RLS SET LOCAL / audit trail)
   */
  getRunByRunId: (actorId: ActorId, runId: string) => Promise<GraphRun | null>;

  /**
   * Lists runs for a user, ordered by started_at DESC with cursor-based pagination.
   * @param actorId - Actor performing the operation (for RLS SET LOCAL / audit trail)
   * @param userId - Used for RLS tenant scoping (sets app.current_user_id)
   * @param opts - Filtering and pagination options
   */
  listRunsByUser: (
    actorId: ActorId,
    userId: string,
    opts?: {
      status?: GraphRunStatus;
      runKind?: GraphRunKind;
      limit?: number;
      /** ISO string cursor — returns runs with started_at < cursor */
      cursor?: string;
    }
  ) => Promise<GraphRun[]>;

  /**
   * Patches the stateKey on a run record.
   * Used when stateKey is derived after run creation (e.g., scheduled runs
   * where stateKey is computed by the internal API, not the workflow).
   * @param actorId - Actor performing the operation (for RLS SET LOCAL / audit trail)
   */
  patchRunStateKey: (
    actorId: ActorId,
    runId: string,
    stateKey: string
  ) => Promise<void>;
}
