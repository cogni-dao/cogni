// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/services/run-id-factory`
 * Purpose: Single owner of run identity semantics for graph execution.
 * Scope: Creates RunIdentity for graph runs. Does NOT persist (P0) or allocate from store (P1).
 * Invariants:
 *   - P0_ATTEMPT_FREEZE: attempt is always 0 (no retry logic)
 *   - P0: runId = ingressRequestId = ctx.reqId (no persistence yet)
 *   - P1: runId allocated from RunStore; ingressRequestId is delivery correlation only
 *   - RUNID_IS_CANONICAL: runId is execution identity; ingressRequestId is transport correlation
 * Side-effects: none
 * Links: ai_runtime.ts, GRAPH_EXECUTION.md
 * @public
 */

import type { RequestContext } from "@/shared/observability";

/**
 * Run identity for graph execution.
 * Contains all fields needed to identify a graph run and its delivery context.
 */
export interface RunIdentity {
  /** Canonical execution identity (groups all LLM calls in one run) */
  readonly runId: string;
  /** Retry attempt number (P0: always 0) */
  readonly attempt: number;
  /** Delivery-layer correlation (HTTP/SSE/worker/queue) */
  readonly ingressRequestId: string;
}

/**
 * Create run identity for a new graph execution.
 *
 * P0 semantics: runId = ingressRequestId = ctx.reqId (no persistence).
 * P1 will allocate runId from RunStore for resume/retry support.
 *
 * @param ctx - Request context containing reqId for correlation
 * @returns Run identity with P0 semantics
 */
export function createRunIdentity(ctx: RequestContext): RunIdentity {
  // P0: runId equals ingressRequestId (no run persistence yet)
  // P1: runId will be allocated from RunStore; many ingressRequestIds per runId
  return {
    runId: ctx.reqId,
    attempt: 0, // P0_ATTEMPT_FREEZE
    ingressRequestId: ctx.reqId,
  };
}
