// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/graphs.run.internal.v1.contract`
 * Purpose: Contract for internal graph execution API (scheduler-worker → app).
 * Scope: Defines wire format for POST /api/internal/graphs/{graphId}/runs. Does not contain business logic.
 * Invariants:
 *   - Contract remains stable; breaking changes require new version
 *   - All consumers use z.infer types
 *   - Idempotency-Key header required for deduplication
 *   - Bearer token auth required (SCHEDULER_API_TOKEN)
 *   - Uses AiExecutionErrorCode from @cogni/ai-core (no parallel error system)
 *   - HTTP errors for auth/validation (401/403/404/422), not response body
 * Side-effects: none
 * Links: /api/internal/graphs/[graphId]/runs route, https://node-template.cognidao.org/knowledge/scheduled-run-grant-contract
 * @internal
 */

import { AI_EXECUTION_ERROR_CODES } from "@cogni/ai-core";
import { z } from "zod";

/**
 * Internal graph run request schema.
 * Per SCHEDULER_SPEC.md: Worker calls with executionGrantId and input.
 */
export const InternalGraphRunInputSchema = z.object({
  /** Execution grant ID for authorization (null for API-triggered runs) */
  executionGrantId: z.string().uuid().nullable().optional(),
  /** Graph input payload (messages, model, etc.) */
  input: z.record(z.string(), z.unknown()),
  /**
   * Optional runId - if provided, use it; otherwise generate.
   * Per SCHEDULER_SPEC.md: Worker provides canonical runId for correlation
   * with graph_runs and charge_receipts.
   */
  runId: z.string().uuid().optional(),
});

/**
 * Internal graph run response schema.
 * Aligns with GraphFinal shape from @cogni/graph-execution-core.
 *
 * HTTP errors handled separately:
 * - 401: Missing/invalid SCHEDULER_API_TOKEN
 * - 403: Grant invalid/expired/revoked/scope mismatch
 * - 404: Graph not found
 * - 422: Idempotency conflict (returns cached result in body)
 */
export const InternalGraphRunOutputSchema = z.discriminatedUnion("ok", [
  // Success
  z.object({
    ok: z.literal(true),
    /** GraphExecutorPort runId for correlation */
    runId: z.string(),
    /** Langfuse trace ID (null if Langfuse not configured) */
    traceId: z.string().nullable(),
    /** Structured output from graph (when responseFormat was provided). Typed by caller. */
    structuredOutput: z.unknown().optional(),
  }),
  // Execution failed (graph ran but errored)
  z.object({
    ok: z.literal(false),
    /** GraphExecutorPort runId for correlation */
    runId: z.string(),
    /** Langfuse trace ID (null if Langfuse not configured) */
    traceId: z.string().nullable(),
    /** Error code from ai-core (reuses existing canonical codes) */
    error: z.enum(AI_EXECUTION_ERROR_CODES),
  }),
]);

export const internalGraphRunOperation = {
  id: "graphs.run.internal.v1",
  summary: "Execute graph via internal API (scheduler-worker only)",
  description:
    "Internal endpoint for scheduled graph execution. Requires Bearer SCHEDULER_API_TOKEN and Idempotency-Key header. Returns runId and traceId for correlation.",
  input: InternalGraphRunInputSchema,
  output: InternalGraphRunOutputSchema,
} as const;

// Export inferred types - all consumers MUST use these, never manual interfaces
export type InternalGraphRunInput = z.infer<typeof InternalGraphRunInputSchema>;
export type InternalGraphRunOutput = z.infer<
  typeof InternalGraphRunOutputSchema
>;
