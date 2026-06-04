// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/services/completion`
 * Purpose: Use case orchestration for AI completion with dual-cost billing.
 * Scope: Execute LLM calls, record usage/metrics/telemetry. Does not handle auth or message filtering.
 * Invariants:
 * - Only imports core, ports, shared - never contracts or adapters
 * - GRAPH_OWNS_MESSAGES: Messages pass through unchanged; graphs own system prompts
 * - Credit check at facade level (preflightCreditCheck), not in executeStream
 * - Post-call billing via RunEventRelay → usage_report events
 * - request_id is stable per request entry (ctx.reqId), NOT regenerated per LLM call
 * - ERROR_NORMALIZATION_ONCE: Connection-time errors caught and normalized via try/catch
 * Side-effects: IO (via ports)
 * Notes: Uses adapter promptHash when available (canonical); fallback hash for error-path only
 * Links: Called by adapters via GraphExecutorPort, uses core domain and ports, ERROR_HANDLING_ARCHITECTURE.md
 * @public
 */

import { randomUUID } from "node:crypto";
import { isLlmError, normalizeErrorToExecutionCode } from "@cogni/ai-core";
import type { Message } from "@cogni/node-core";
import {
  computePromptHash,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
} from "@cogni/node-shared";
import type { Logger } from "pino";
import type { StreamFinalResult } from "@/features/ai/types";
import type {
  AccountService,
  AiTelemetryPort,
  Clock,
  LangfusePort,
  LlmCaller,
  LlmCompletionResult,
  LlmService,
} from "@/ports";
import type { AiLlmCallEvent, RequestContext } from "@/shared/observability";
// recordBilling removed: billing now via RunEventRelay + commitUsageFact (GRAPH_EXECUTION.md)
import { recordMetrics } from "./metrics";
import { recordTelemetry } from "./telemetry";

// ============================================================================
// P3: Shared post-call handling (DRY consolidation)
// ============================================================================

/**
 * Context for post-call handling (shared between execute and executeStream).
 */
interface PostCallContext {
  readonly invocationId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly routeId: string;
  readonly fallbackPromptHash: string;
  readonly requestedModel: string;
  readonly llmStart: number;
  readonly caller: LlmCaller;
  readonly provenance: "response" | "stream";
  readonly accountService: AccountService;
  readonly aiTelemetry: AiTelemetryPort;
  readonly langfuse: LangfusePort | undefined;
}

/**
 * Handle successful LLM completion (metrics, telemetry).
 * Used by both execute() and executeStream().
 * Note: Billing now handled by RunEventRelay via usage_report events (GRAPH_EXECUTION.md).
 */
async function handleLlmSuccess(
  result: LlmCompletionResult,
  context: PostCallContext,
  log: Logger
): Promise<void> {
  const {
    invocationId,
    requestId,
    traceId,
    routeId,
    fallbackPromptHash,
    requestedModel,
    llmStart,
    caller,
    provenance,
    // accountService unused: billing via RunEventRelay (GRAPH_EXECUTION.md)
    aiTelemetry,
    langfuse,
  } = context;

  // Extract model ID from provider metadata
  const totalTokens = result.usage?.totalTokens ?? 0;
  const providerMeta = (result.providerMeta ?? {}) as Record<string, unknown>;
  const modelId =
    typeof providerMeta.model === "string" ? providerMeta.model : "unknown";

  // Invariant enforcement: log when model resolution fails
  if (modelId === "unknown") {
    log.warn(
      {
        requestId,
        requestedModel,
        streaming: provenance === "stream",
        hasProviderMeta: !!result.providerMeta,
        providerMetaKeys: result.providerMeta
          ? Object.keys(result.providerMeta)
          : [],
      },
      "inv_provider_meta_model_missing: Model name missing from LLM response"
    );
  }

  // Log LLM call with structured event
  const durationMs = performance.now() - llmStart;
  const llmEvent: AiLlmCallEvent = {
    event: "ai.llm_call",
    routeId,
    reqId: requestId,
    billingAccountId: caller.billingAccountId,
    model: modelId,
    durationMs,
    tokensUsed: totalTokens,
    providerCostUsd: result.providerCostUsd,
  };
  log.info(llmEvent, "ai.llm_call_completed");

  // Record LLM metrics
  await recordMetrics({
    model: modelId,
    durationMs,
    ...(totalTokens !== undefined && { tokensUsed: totalTokens }),
    ...(result.providerCostUsd !== undefined && {
      providerCostUsd: result.providerCostUsd,
    }),
    isError: false,
  });

  // Billing handled by RunEventRelay via usage_report events (per GRAPH_EXECUTION.md)
  // adapter emits usage_report → RunEventRelay billing subscriber → commitUsageFact()

  // Record success telemetry
  const latencyMs = Math.max(0, Math.round(durationMs));
  await recordTelemetry(
    {
      invocationId,
      requestId,
      traceId,
      fallbackPromptHash,
      canonicalPromptHash: result.promptHash,
      model: modelId,
      latencyMs,
      status: "success",
      resolvedProvider: result.resolvedProvider,
      resolvedModel: result.resolvedModel,
      usage: result.usage,
      providerCostUsd: result.providerCostUsd,
      litellmCallId: result.litellmCallId,
    },
    aiTelemetry,
    langfuse,
    log
  );
}

/**
 * Handle failed LLM completion (metrics, telemetry).
 * Used by both execute() and executeStream().
 * Note: Does NOT call recordBilling (no charge on error).
 */
async function handleLlmError(
  error: unknown,
  context: PostCallContext,
  log: Logger
): Promise<void> {
  const {
    invocationId,
    requestId,
    traceId,
    fallbackPromptHash,
    requestedModel,
    llmStart,
    aiTelemetry,
    langfuse,
  } = context;

  const durationMs = performance.now() - llmStart;

  // Normalize error ONCE at this boundary
  const executionCode = normalizeErrorToExecutionCode(error);

  // Record error metric with normalized code
  await recordMetrics({
    model: requestedModel,
    durationMs,
    isError: true,
    errorCode: executionCode,
  });

  // Record error telemetry
  const latencyMs = Math.max(0, Math.round(durationMs));
  const errorKind = isLlmError(error) ? error.kind : "unknown";
  await recordTelemetry(
    {
      invocationId,
      requestId,
      traceId,
      fallbackPromptHash,
      model: requestedModel,
      latencyMs,
      status: "error",
      errorCode: errorKind,
    },
    aiTelemetry,
    langfuse,
    log
  );
}

// ============================================================================
// Public API (frozen signatures per API_FROZEN invariant)
// ============================================================================

/**
 * @deprecated Dead code - facade's completion() uses completionStream() per UNIFIED_GRAPH_EXECUTOR.
 * TODO: Delete this function or refactor to call executeStream() and drain events.
 * Do not maintain parallel implementations - they will diverge on prompt/billing behavior.
 */
export async function execute(
  _messages: Message[],
  _model: string,
  _llmService: LlmService,
  _accountService: AccountService,
  _clock: Clock,
  _caller: LlmCaller,
  _ctx: RequestContext,
  _aiTelemetry: AiTelemetryPort,
  _langfuse: LangfusePort | undefined
): Promise<{ message: Message; requestId: string }> {
  // TODO: Refactor to call executeStream() and drain events, or delete entirely.
  throw new Error(
    "execute() is deprecated. Use executeStream() via GraphExecutorPort instead."
  );
}

export interface ExecuteStreamParams {
  messages: Message[];
  model: string;
  llmService: LlmService;
  accountService: AccountService;
  clock: Clock;
  caller: LlmCaller;
  ctx: RequestContext;
  aiTelemetry: AiTelemetryPort;
  langfuse: LangfusePort | undefined;
  abortSignal?: AbortSignal;
  /** Optional tools for function calling (readonly for immutability) */
  tools?: readonly import("@/ports").LlmToolDefinition[];
  /** Optional tool choice policy */
  toolChoice?: import("@/ports").LlmToolChoice;
  /** Billing correlation metadata forwarded to LiteLLM as x-litellm-spend-logs-metadata header */
  spendLogsMetadata?: { run_id: string; graph_id: string; node_id?: string };
}

/**
 * Execute streaming LLM completion.
 *
 * Per GRAPH_OWNS_MESSAGES: This is a pure executor. Messages pass through unchanged.
 * Credit check happens at facade level (preflightCreditCheck), not here.
 */
export async function executeStream({
  messages,
  model,
  llmService,
  accountService,
  clock: _clock,
  caller,
  ctx,
  aiTelemetry,
  langfuse,
  abortSignal,
  tools,
  toolChoice,
  spendLogsMetadata,
}: ExecuteStreamParams): Promise<{
  stream: AsyncIterable<import("@/ports").ChatDeltaEvent>;
  final: Promise<StreamFinalResult>;
}> {
  const log = ctx.log.child({ feature: "ai.completion.stream" });

  // Fallback hash for error-path telemetry only (adapter provides canonical hash on success).
  // Uses defaults; may not match actual provider params. Acceptable for error-path approximation.
  const fallbackPromptHash = computePromptHash({
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
  });

  // Per spec: request_id is stable per request entry (from ctx.reqId)
  const requestId = ctx.reqId;
  // Per AI_SETUP_SPEC.md: invocation_id is unique per LLM call attempt
  const invocationId = randomUUID();
  const llmStart = performance.now();

  // Build shared context for post-call handling
  const postCallContext: PostCallContext = {
    invocationId,
    requestId,
    traceId: ctx.traceId,
    routeId: ctx.routeId,
    fallbackPromptHash,
    requestedModel: model,
    llmStart,
    caller,
    provenance: "stream",
    accountService,
    aiTelemetry,
    langfuse,
  };

  log.debug({ messageCount: messages.length }, "starting LLM stream");

  // Per GRAPH_OWNS_MESSAGES: pass messages through unchanged
  // Wrap in try/catch for connection-time errors (e.g., 429 before stream starts)
  let stream: AsyncIterable<import("@/ports").ChatDeltaEvent>;
  let final: Promise<import("@/ports").LlmCompletionResult>;

  try {
    const result = await llmService.completionStream({
      messages,
      model,
      caller,
      ...(abortSignal && { abortSignal }),
      ...(tools && tools.length > 0 && { tools }),
      ...(toolChoice && { toolChoice }),
      ...(spendLogsMetadata && { spendLogsMetadata }),
    });
    stream = result.stream;
    final = result.final;
  } catch (error) {
    // Connection-time error (e.g., HTTP 429 before streaming starts)
    log.error({ err: error, requestId }, "Stream connection failed");
    await handleLlmError(error, postCallContext, log);

    // Create error stream that emits error + done
    const errorCode = normalizeErrorToExecutionCode(error);
    const errorStream = (async function* () {
      yield { type: "error" as const, error: errorCode };
      yield { type: "done" as const };
    })();

    // Return normalized error result
    return {
      stream: errorStream,
      final: Promise.resolve({
        ok: false as const,
        requestId,
        error: errorCode,
      }),
    };
  }

  // Wrap final promise to handle billing/telemetry
  // INVARIANT: STREAMING_SIDE_EFFECTS_ONCE - side effects fire ONLY from this promise
  const wrappedFinal = final
    .then(async (result) => {
      await handleLlmSuccess(result, postCallContext, log);

      // Extract model ID from provider metadata for billing
      const providerMeta = (result.providerMeta ?? {}) as Record<
        string,
        unknown
      >;
      const modelId =
        (typeof providerMeta.model === "string" ? providerMeta.model : null) ??
        result.resolvedModel ??
        null;

      // Build base result
      const baseResult = {
        ok: true as const,
        requestId,
        usage: {
          promptTokens: result.usage?.promptTokens ?? 0,
          completionTokens: result.usage?.completionTokens ?? 0,
        },
        finishReason: result.finishReason ?? "stop",
      };

      // Prefer display name over raw model ID for downstream billing/display
      const displayModel = result.resolvedDisplayName ?? modelId;

      // Add billing fields, tool calls, and content when present (exactOptionalPropertyTypes compliance)
      return {
        ...baseResult,
        ...(displayModel && { model: displayModel }),
        ...(result.providerCostUsd !== undefined && {
          providerCostUsd: result.providerCostUsd,
        }),
        ...(result.litellmCallId && { litellmCallId: result.litellmCallId }),
        ...(result.toolCalls &&
          result.toolCalls.length > 0 && { toolCalls: result.toolCalls }),
        ...(result.message?.content && { content: result.message.content }),
      };
    })
    .catch(async (error) => {
      log.error({ err: error, requestId }, "Stream execution failed");
      await handleLlmError(error, postCallContext, log);

      // Return discriminated union with normalized error code
      // Per ERROR_NORMALIZATION_ONCE: normalize here, propagate everywhere
      return {
        ok: false as const,
        requestId,
        error: normalizeErrorToExecutionCode(error),
      };
    });

  return { stream, final: wrappedFinal };
}
