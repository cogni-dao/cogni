// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai-telemetry/drizzle.adapter`
 * Purpose: Drizzle implementation of AiTelemetryPort for DB persistence.
 * Scope: Write AI invocation summaries to PostgreSQL; always wired (not dependent on Langfuse).
 * Invariants:
 *   - Uses invocation_id as idempotency key (UNIQUE constraint)
 *   - Records on BOTH success AND error paths
 *   - Never throws (swallows ALL errors including non-duplicates)
 *   - Telemetry is best-effort; failures logged but never propagate
 * Side-effects: IO (DB writes)
 * Notes: Per AI_SETUP_SPEC.md P0 scope
 * Links: AiTelemetryPort, ai_invocation_summaries schema
 * @public
 */

import type { Database } from "@/adapters/server/db/client";
import type { AiTelemetryPort, RecordInvocationParams } from "@/ports";
import { aiInvocationSummaries } from "@/shared/db/schema";
import { makeLogger } from "@/shared/observability";

const logger = makeLogger({ component: "DrizzleAiTelemetryAdapter" });

/**
 * Drizzle-based implementation of AiTelemetryPort.
 * Writes AI invocation summaries to ai_invocation_summaries table.
 * Always wired in container (works without Langfuse).
 */
export class DrizzleAiTelemetryAdapter implements AiTelemetryPort {
  constructor(private readonly db: Database) {}

  /**
   * Record an AI invocation summary to the database.
   * Uses invocation_id as idempotency key.
   *
   * Per AI_SETUP_SPEC.md:
   * - Called on BOTH success AND error paths
   * - Idempotent (UNIQUE constraint on invocation_id prevents duplicates)
   * - Swallows duplicate key errors (expected for retries)
   */
  async recordInvocation(params: RecordInvocationParams): Promise<void> {
    try {
      await this.db.insert(aiInvocationSummaries).values({
        invocationId: params.invocationId,
        requestId: params.requestId,
        traceId: params.traceId,
        langfuseTraceId: params.langfuseTraceId ?? null,
        litellmCallId: params.litellmCallId ?? null,
        promptHash: params.promptHash,
        routerPolicyVersion: params.routerPolicyVersion,
        graphRunId: params.graphRunId ?? null,
        graphName: params.graphName ?? null,
        graphVersion: params.graphVersion ?? null,
        provider: params.provider,
        model: params.model,
        tokensIn: params.tokensIn ?? null,
        tokensOut: params.tokensOut ?? null,
        tokensTotal: params.tokensTotal ?? null,
        providerCostUsd: params.providerCostUsd?.toString() ?? null,
        // Defensive guard: ensure integer for DB schema (callers should already round)
        latencyMs: Math.max(0, Math.round(params.latencyMs)),
        status: params.status,
        errorCode: params.errorCode ?? null,
      });
    } catch (error) {
      // Per AI_SETUP_SPEC.md: Telemetry adapter must NEVER throw through request path
      // All errors are swallowed and logged - telemetry is best-effort
      // PostgreSQL error code 23505 = unique_violation (expected for retries)
      const isDuplicate =
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "23505";

      if (!isDuplicate) {
        // Log non-duplicate errors for debugging (but don't throw)
        logger.error(
          { err: error instanceof Error ? error : new Error(String(error)) },
          "recordInvocation failed (swallowed)"
        );
      }
      // Always swallow - never propagate to request path
    }
  }
}
