// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-core/execution-context`
 * Purpose: Per-run cross-cutting metadata for graph execution.
 * Scope: Typed context passed alongside GraphRunRequest. Does not include billing credentials or tracing IDs.
 * Invariants:
 *   - NO_BILLING_LEAKAGE: No billingAccountId, virtualKeyId, or billing types
 *   - NO_TRACING_LEAKAGE: No traceId — flows via OTel context propagation
 * Side-effects: none (type only)
 * Links: docs/spec/unified-graph-launch.md
 * @public
 */

/**
 * Per-run cross-cutting metadata.
 *
 * Passed as the second argument to `GraphExecutorPort.runGraph()`.
 * Contains only what downstream code legitimately needs beyond the
 * pure business input on GraphRunRequest.
 *
 * What stays OUT of this interface:
 * - Billing credentials → resolved by injected BillingResolver in the app layer
 * - traceId → flows via OTel context propagation (Temporal SDK propagates automatically)
 * - requestId → HTTP edge correlation, stays in app-layer logs/interceptors
 * - abortSignal → browser disconnect ≠ durable run cancellation;
 *   Temporal uses Context.current().cancellationSignal for activity cancellation
 */
export interface ExecutionContext {
  /** Exact runtime principal (for example agent:{node_id}/{actor_id}). */
  readonly actorId?: string;
  /** Actor who initiated this run (user ID for user-initiated, undefined for system) */
  readonly actorUserId?: string;
  /** Session ID for observability grouping (e.g., Langfuse sessions) */
  readonly sessionId?: string;
  /** Privacy flag — when true, content is scrubbed before telemetry */
  readonly maskContent?: boolean;
  /**
   * Launcher-generated correlation ID for a single run trigger.
   * Used by chat, schedules, and webhooks — not an HTTP-only concept, not a trace ID.
   * Distinct from runId (durable execution identity) and traceId (OTel propagation).
   */
  readonly requestId?: string;
}
