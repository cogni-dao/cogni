// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/services/telemetry`
 * Purpose: Record AI invocation to DB (ai_invocation_summaries).
 * Scope: Write invocation metrics to DB. Does NOT create Langfuse traces or generations (decorator + LiteLLM handle that).
 * Invariants:
 *   - Called on BOTH success AND error paths
 *   - PROMPTHASH_DUAL_RESOLUTION: resolvedPromptHash = canonicalPromptHash ?? fallbackPromptHash
 *   - LITELLM_OWNS_GENERATIONS: LiteLLM->Langfuse callback creates generation observations
 *   - Never throws (telemetry should not block response)
 * Side-effects: IO (writes to DB via AiTelemetryPort)
 * Notes: Decorator creates trace; LiteLLM creates generations; this service only records to DB.
 * Links: completion.ts, ports/ai-telemetry.port.ts, AI_SETUP_SPEC.md
 * @public
 */

import type { LlmErrorKind } from "@cogni/ai-core";
import type { Logger } from "pino";
import type { AiTelemetryPort, LangfusePort } from "@/ports";
import { serverEnv } from "@/shared/env";

/**
 * Base context for all telemetry recording.
 */
interface TelemetryContextBase {
  readonly invocationId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly fallbackPromptHash: string;
  readonly model: string;
  readonly latencyMs: number;
}

/**
 * Context for success telemetry.
 */
export interface TelemetryContextSuccess extends TelemetryContextBase {
  readonly status: "success";
  readonly canonicalPromptHash: string | undefined;
  readonly resolvedProvider: string | undefined;
  readonly resolvedModel: string | undefined;
  readonly usage:
    | {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      }
    | undefined;
  readonly providerCostUsd: number | undefined;
  readonly litellmCallId: string | undefined;
  // Graph fields (P1-ready)
  readonly graphRunId?: string;
  readonly graphName?: string;
  readonly graphVersion?: string;
}

/**
 * Context for error telemetry.
 */
export interface TelemetryContextError extends TelemetryContextBase {
  readonly status: "error";
  readonly errorCode: LlmErrorKind;
}

/**
 * Union type for telemetry context.
 */
export type TelemetryContext = TelemetryContextSuccess | TelemetryContextError;

/**
 * Record AI invocation telemetry to DB.
 *
 * Called on both success and error paths.
 * Never throws - telemetry should not block user response.
 *
 * Invariants:
 * - PROMPTHASH_DUAL_RESOLUTION: resolvedPromptHash = canonicalPromptHash ?? fallbackPromptHash
 * - LITELLM_OWNS_GENERATIONS: LiteLLM->Langfuse callback handles generation observations
 * - Never throws (catches all errors internally)
 *
 * @param context - Telemetry context from LLM result
 * @param aiTelemetry - DB telemetry port
 * @param langfuse - Optional Langfuse port (used only for traceId correlation in DB)
 * @param log - Logger for error reporting
 * @returns langfuseTraceId if Langfuse enabled, undefined otherwise
 */
export async function recordTelemetry(
  context: TelemetryContext,
  aiTelemetry: AiTelemetryPort,
  langfuse: LangfusePort | undefined,
  log: Logger
): Promise<string | undefined> {
  const {
    invocationId,
    requestId,
    traceId,
    fallbackPromptHash,
    model,
    latencyMs,
    status,
  } = context;

  // PROMPTHASH_DUAL_RESOLUTION: prefer canonical (from adapter) over fallback
  const resolvedPromptHash =
    status === "success"
      ? (context.canonicalPromptHash ?? fallbackPromptHash)
      : fallbackPromptHash;

  const resolvedModel =
    status === "success" ? (context.resolvedModel ?? model) : model;

  // LiteLLM->Langfuse integration handles generation observations (success_callback)
  // We only record to DB here; decorator handles trace lifecycle

  // Record to DB
  // langfuseTraceId = traceId when Langfuse is enabled (trace created by decorator)
  const langfuseTraceId = langfuse ? traceId : undefined;

  try {
    if (status === "success") {
      await aiTelemetry.recordInvocation({
        invocationId,
        requestId,
        traceId,
        ...(langfuseTraceId ? { langfuseTraceId } : {}),
        provider: context.resolvedProvider ?? "unknown",
        model: resolvedModel,
        promptHash: resolvedPromptHash,
        routerPolicyVersion: serverEnv().ROUTER_POLICY_VERSION,
        status: "success",
        latencyMs,
        ...(context.usage?.promptTokens !== undefined
          ? { tokensIn: context.usage.promptTokens }
          : {}),
        ...(context.usage?.completionTokens !== undefined
          ? { tokensOut: context.usage.completionTokens }
          : {}),
        ...(context.usage?.totalTokens !== undefined
          ? { tokensTotal: context.usage.totalTokens }
          : {}),
        ...(context.providerCostUsd !== undefined
          ? { providerCostUsd: context.providerCostUsd }
          : {}),
        ...(context.litellmCallId
          ? { litellmCallId: context.litellmCallId }
          : {}),
      });
    } else {
      await aiTelemetry.recordInvocation({
        invocationId,
        requestId,
        traceId,
        ...(langfuseTraceId ? { langfuseTraceId } : {}),
        provider: "unknown", // Not available on error (no response)
        model,
        promptHash: fallbackPromptHash, // Real hash computed BEFORE LLM call
        routerPolicyVersion: serverEnv().ROUTER_POLICY_VERSION,
        status: "error",
        errorCode: context.errorCode,
        latencyMs,
      });
    }
  } catch (telemetryError) {
    // Telemetry should never block user response
    log.error(
      { err: telemetryError, invocationId },
      `Failed to record ${status} telemetry`
    );
  }

  return langfuseTraceId;
}
