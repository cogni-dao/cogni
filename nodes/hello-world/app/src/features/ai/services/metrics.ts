// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/services/metrics`
 * Purpose: Prometheus metrics recording for LLM calls.
 * Scope: Record duration histogram, token counter, cost counter, error counter. Does NOT perform billing or telemetry.
 * Invariants:
 *   - Records ai_llm_call_duration_ms histogram
 *   - Increments ai_llm_tokens_total counter
 *   - Increments ai_llm_cost_usd_total counter
 *   - Increments ai_llm_errors_total on error path
 * Side-effects: IO (writes to Prometheus registry)
 * Notes: Per COMPLETION_REFACTOR_PLAN.md P1 extraction
 * Links: completion.ts, shared/observability/server/metrics.ts
 * @public
 */

import type { AiExecutionErrorCode } from "@cogni/ai-core";
import { getModelClass } from "@/shared/ai/model-catalog.server";
import {
  aiLlmCallDurationMs,
  aiLlmCostUsdTotal,
  aiLlmErrorsTotal,
  aiLlmTokensTotal,
} from "@/shared/observability";

/**
 * Context for recording LLM metrics.
 * Per ERROR_NORMALIZATION_ONCE: errorCode is pre-normalized AiExecutionErrorCode.
 */
export interface MetricsContext {
  readonly model: string;
  readonly durationMs: number;
  readonly tokensUsed?: number;
  readonly providerCostUsd?: number;
  readonly isError: boolean;
  /** Pre-normalized error code from completion boundary */
  readonly errorCode?: AiExecutionErrorCode;
}

/**
 * Record Prometheus metrics for an LLM call.
 *
 * For success path: records duration, tokens, and cost.
 * For error path: records error counter only.
 *
 * @param context - Metrics context from LLM result
 */
export async function recordMetrics(context: MetricsContext): Promise<void> {
  const modelClass = await getModelClass(context.model);

  if (context.isError) {
    // Error path: increment error counter
    aiLlmErrorsTotal.inc({
      provider: "litellm",
      code: context.errorCode ?? "unknown",
      model_class: modelClass,
    });
    return;
  }

  // Success path: record duration, tokens, cost
  aiLlmCallDurationMs.observe(
    { provider: "litellm", model_class: modelClass },
    context.durationMs
  );

  if (context.tokensUsed) {
    aiLlmTokensTotal.inc(
      { provider: "litellm", model_class: modelClass },
      context.tokensUsed
    );
  }

  if (typeof context.providerCostUsd === "number") {
    aiLlmCostUsdTotal.inc(
      { provider: "litellm", model_class: modelClass },
      context.providerCostUsd
    );
  }
}
