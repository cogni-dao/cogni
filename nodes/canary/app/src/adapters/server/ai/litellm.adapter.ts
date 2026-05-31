// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/litellm`
 * Purpose: LiteLLM service implementation for AI completion and streaming with cost extraction and runtime secret validation.
 * Scope: Implements LlmService port (completion + stream), extracts cost from headers, validates secrets at adapter boundary. Does not handle auth or rate-limiting.
 * Invariants:
 *   - Never logs prompts/keys/chunks; error response excerpts are redacted + bounded (<=2KB)
 *   - 30s timeout (completion), 15s connect timeout (stream)
 *   - Settles once; model required
 *   - Stream abort rejects with LlmError(kind='aborted')
 *   - USAGE_UNIT_IS_LITELLM_CALL_ID: litellmCallId sourced ONLY from x-litellm-call-id response header (no response body fallback)
 * Side-effects: IO (HTTP calls to LiteLLM)
 * Notes:
 *   - SSE via eventsource-parser; assertRuntimeSecrets() before fetch
 *   - Logs only bounded metadata (no content)
 *   - Aborted streams are errors, not partial successes
 * Links: LlmService port, serverEnv, assertRuntimeSecrets, defer<T>() for promise settlement
 * @internal
 */

import {
  computePromptHash,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  scrubStringContent,
} from "@cogni/node-shared";
import {
  createParser,
  type EventSourceMessage,
  type EventSourceParser,
} from "eventsource-parser";
import {
  type ChatDeltaEvent,
  classifyLlmErrorFromStatus,
  LlmError,
  type LlmService,
  type LlmToolCall,
  type LlmToolCallDelta,
} from "@/ports";
import { getCachedModels } from "@/shared/ai/model-catalog.server";
import { serverEnv } from "@/shared/env";
import { assertRuntimeSecrets } from "@/shared/env/invariants";
import { makeLogger } from "@/shared/observability";

const logger = makeLogger({ component: "LiteLlmAdapter" });

// ─────────────────────────────────────────────────────────────────────────────
// Private error diagnostics (operator logs only — never returned to callers)
// ─────────────────────────────────────────────────────────────────────────────

/** Max chars of provider response body to include in operator logs. */
const MAX_ERROR_BODY_LOG_CHARS = 2048;

/**
 * Safely read and redact error response body for operator diagnostics.
 * Truncates to MAX_ERROR_BODY_LOG_CHARS, redacts secrets via shared scrubber, never throws.
 * Logged in operator logs ONLY — never attached to thrown errors or returned to callers.
 */
async function readErrorResponseExcerpt(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const truncated =
      text.length > MAX_ERROR_BODY_LOG_CHARS
        ? `${text.slice(0, MAX_ERROR_BODY_LOG_CHARS)}…[truncated]`
        : text;
    return scrubStringContent(truncated);
  } catch {
    return "[unreadable]";
  }
}

/**
 * Extract provider name from LiteLLM model ID prefix.
 * e.g., "openai/gpt-4" → "openai", "anthropic/claude-3" → "anthropic"
 * Falls back to "unknown" if no prefix.
 */
function extractProviderFromModel(model: string): string {
  const slashIndex = model.indexOf("/");
  if (slashIndex > 0) {
    return model.slice(0, slashIndex);
  }
  // Fallback: try to infer from known model prefixes
  if (model.startsWith("gpt-") || model.startsWith("o1")) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  return "unknown";
}

/**
 * Look up display name for a LiteLLM config model name from the cached catalog.
 * Returns undefined if catalog unavailable or model not found.
 */
async function lookupDisplayName(modelId: string): Promise<string | undefined> {
  try {
    const { models } = await getCachedModels();
    return models.find((m) => m.id === modelId)?.name ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create a deferred promise with resolve/reject callbacks.
 * Ensures promise settles exactly once.
 */
function defer<T>() {
  let settled = false;
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      if (!settled) {
        settled = true;
        res(value);
      }
    };
    reject = (reason) => {
      if (!settled) {
        settled = true;
        rej(reason);
      }
    };
  });
  return { promise, resolve, reject };
}

/**
 * Extract provider cost from LiteLLM response headers.
 * Quarantines null at the boundary and returns number | undefined.
 */
function getProviderCostFromHeaders(response: Response): number | undefined {
  const raw = response.headers.get("x-litellm-response-cost");
  if (!raw || raw.trim().length === 0) return undefined;

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Extract LiteLLM call ID from response headers for forensic correlation.
 * Returns undefined if header is absent or empty.
 */
function getLitellmCallIdFromHeaders(response: Response): string | undefined {
  const raw = response.headers.get("x-litellm-call-id");
  if (!raw || raw.trim().length === 0) return undefined;
  return raw.trim();
}

export class LiteLlmAdapter implements LlmService {
  async completion(
    params: Parameters<LlmService["completion"]>[0]
  ): ReturnType<LlmService["completion"]> {
    // Model must be provided by caller (route validates via contract)
    if (!params.model) {
      throw new Error("LiteLLM completion requires model parameter");
    }
    const model = params.model;
    const temperature = params.temperature ?? DEFAULT_TEMPERATURE;
    const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

    // Extract caller data for user attribution and correlation (cost tracking in LiteLLM)
    const {
      billingAccountId,
      requestId,
      traceId,
      sessionId,
      userId,
      maskContent,
    } = params.caller;

    // Canonical messages for prompt hash (role + content only per AI_SETUP_SPEC.md)
    const canonicalMessages = params.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Compute prompt hash BEFORE adding metadata (per AI_SETUP_SPEC.md)
    const promptHash = computePromptHash({
      model,
      messages: canonicalMessages,
      temperature,
      maxTokens,
    });

    // Convert core Messages to LiteLLM format (includes tool fields for agentic loop)
    const liteLlmMessages = params.messages.map((msg) => {
      const base: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };
      // Assistant messages with tool calls (OpenAI format)
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        base.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));
      }
      // Tool result messages need tool_call_id
      if (msg.role === "tool" && msg.toolCallId) {
        base.tool_call_id = msg.toolCallId;
      }
      return base;
    });

    const requestBody = {
      model,
      messages: liteLlmMessages,
      temperature,
      max_tokens: maxTokens,
      user: billingAccountId, // LiteLLM user tracking for cost attribution
      metadata: {
        cogni_billing_account_id: billingAccountId,
        request_id: requestId,
        // existing_trace_id: attach observations to decorator's trace without modifying it
        existing_trace_id: traceId,
        ...(sessionId && { session_id: sessionId }),
        ...(userId && { trace_user_id: userId }),
        ...(maskContent && { mask_input: true, mask_output: true }),
      },
    };

    const env = serverEnv();
    // Validate runtime secrets at adapter boundary (not in serverEnv to avoid breaking Next.js build)
    assertRuntimeSecrets(env);

    let response: Response;
    try {
      // HTTP call to LiteLLM with timeout enforcement
      // Uses LITELLM_MASTER_KEY (server-only secret) - never expose per-user virtual keys
      response = await fetch(`${env.LITELLM_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.LITELLM_MASTER_KEY}`,
          ...(params.spendLogsMetadata && {
            "x-litellm-spend-logs-metadata": JSON.stringify(
              params.spendLogsMetadata
            ),
          }),
        },
        body: JSON.stringify(requestBody),
        /** 30 second timeout */
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      // Handle fetch errors (network, timeout, abort)
      if (error instanceof Error) {
        if (error.name === "AbortError" || error.name === "TimeoutError") {
          logger.warn(
            { requestId, traceId, model, rootCauseKind: "timeout" },
            "adapter.litellm.network_error"
          );
          throw new LlmError(`LiteLLM request timed out`, "timeout", 408);
        }
        const causeCode = (error.cause as { code?: string } | undefined)?.code;
        logger.warn(
          {
            requestId,
            traceId,
            model,
            rootCauseKind: "network",
            errorMessage: error.message,
            ...(causeCode && { causeCode }),
          },
          "adapter.litellm.network_error"
        );
        throw new LlmError(
          `LiteLLM network error: ${error.message}`,
          "unknown"
        );
      }
      throw new LlmError("LiteLLM completion failed: Unknown error", "unknown");
    }

    // Handle HTTP errors with typed LlmError (per AI_SETUP_SPEC.md)
    if (!response.ok) {
      const kind = classifyLlmErrorFromStatus(response.status);
      const responseExcerpt = await readErrorResponseExcerpt(response);
      // Operator log: includes private root cause for debugging (never sent to clients)
      logger.warn(
        {
          statusCode: response.status,
          kind,
          requestId,
          traceId,
          model,
          provider: extractProviderFromModel(model),
          responseExcerpt,
        },
        "adapter.litellm.http_error"
      );
      throw new LlmError(
        `LiteLLM API error: ${response.status} ${response.statusText}`,
        kind,
        response.status
      );
    }

    // Read cost and call ID from response headers
    const providerCostFromHeader = getProviderCostFromHeaders(response);
    const litellmCallId = getLitellmCallIdFromHeaders(response);

    const data = (await response.json()) as {
      id?: string;
      model?: string;
      choices: { message: { content: string }; finish_reason?: string }[];
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens?: number;
      };
    };

    if (
      !data.choices ||
      data.choices.length === 0 ||
      !data.choices[0]?.message ||
      typeof data.choices[0].message.content !== "string"
    ) {
      throw new LlmError("Invalid response from LiteLLM", "unknown");
    }

    // Build result object conditionally to satisfy exactOptionalPropertyTypes
    const promptTokens = Number(data.usage?.prompt_tokens) || 0;
    const completionTokens = Number(data.usage?.completion_tokens) || 0;
    const totalTokens = data.usage?.total_tokens
      ? Number(data.usage.total_tokens)
      : promptTokens + completionTokens;

    // Extract resolved model from response (may differ from requested model)
    const resolvedModel = data.model ?? model;
    const resolvedProvider = extractProviderFromModel(resolvedModel);
    const resolvedDisplayName = await lookupDisplayName(model);

    const result: Awaited<ReturnType<LlmService["completion"]>> = {
      message: {
        role: "assistant",
        content: data.choices[0].message.content,
      },
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
      },
      providerMeta: data as unknown as Record<string, unknown>,
      promptHash,
      resolvedProvider,
      resolvedModel,
      ...(resolvedDisplayName && { resolvedDisplayName }),
    };

    // Add optional fields only when present
    if (data.choices[0].finish_reason) {
      result.finishReason = data.choices[0].finish_reason;
    }

    if (typeof providerCostFromHeader === "number") {
      result.providerCostUsd = providerCostFromHeader;
    }

    // USAGE_UNIT_IS_LITELLM_CALL_ID: header is the ONLY source.
    // Do NOT fall back to data.id (response body) — it may differ from
    // spend_logs.request_id. Missing header = bug, fail deterministically.
    if (litellmCallId) {
      result.litellmCallId = litellmCallId;
    }

    // Sanitized adapter log (no content, bounded fields only)
    logger.info(
      {
        model: resolvedModel,
        provider: resolvedProvider,
        tokensUsed: totalTokens,
        finishReason: result.finishReason,
        hasCost: typeof providerCostFromHeader === "number",
        hasCallId: !!result.litellmCallId,
        contentLength: data.choices[0].message.content.length,
        promptHash,
      },
      "adapter.litellm.completion_result"
    );

    return result;
  }

  async completionStream(
    params: Parameters<LlmService["completionStream"]>[0]
  ): ReturnType<LlmService["completionStream"]> {
    // Model must be provided by caller (route validates via contract)
    if (!params.model) {
      throw new Error("LiteLLM completionStream requires model parameter");
    }
    const model = params.model;
    const temperature = params.temperature ?? DEFAULT_TEMPERATURE;
    const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;
    const {
      billingAccountId,
      requestId,
      traceId,
      sessionId,
      userId,
      maskContent,
    } = params.caller;

    // Canonical messages for prompt hash (role + content only per AI_SETUP_SPEC.md)
    const canonicalMessages = params.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Compute prompt hash BEFORE adding metadata (per AI_SETUP_SPEC.md)
    const promptHash = computePromptHash({
      model,
      messages: canonicalMessages,
      temperature,
      maxTokens,
    });

    // Convert core Messages to LiteLLM format (includes tool fields for agentic loop)
    const liteLlmMessages = params.messages.map((msg) => {
      const base: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };
      // Assistant messages with tool calls (OpenAI format)
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        base.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));
      }
      // Tool result messages need tool_call_id
      if (msg.role === "tool" && msg.toolCallId) {
        base.tool_call_id = msg.toolCallId;
      }
      return base;
    });

    // Build request body with optional tools
    const requestBody: Record<string, unknown> = {
      model,
      messages: liteLlmMessages,
      temperature,
      max_tokens: maxTokens,
      user: billingAccountId, // LiteLLM user tracking for cost attribution
      metadata: {
        cogni_billing_account_id: billingAccountId,
        request_id: requestId,
        // existing_trace_id: attach observations to decorator's trace without modifying it
        existing_trace_id: traceId,
        ...(sessionId && { session_id: sessionId }),
        ...(userId && { trace_user_id: userId }),
        ...(maskContent && { mask_input: true, mask_output: true }),
      },
      stream: true,
      stream_options: { include_usage: true }, // Request usage in stream if supported
    };

    // Add tools if provided (OpenAI function-calling format)
    if (params.tools && params.tools.length > 0) {
      requestBody.tools = params.tools;
    }
    if (params.toolChoice) {
      requestBody.tool_choice = params.toolChoice;
    }

    let response: Response;
    // Use short timeout for connection/TTFB only (not entire stream duration)
    const connectCtl = new AbortController();
    const connectTimer = setTimeout(() => connectCtl.abort(), 15000);
    const env = serverEnv();
    // Validate runtime secrets at adapter boundary
    assertRuntimeSecrets(env);

    try {
      const signal = params.abortSignal
        ? AbortSignal.any([connectCtl.signal, params.abortSignal])
        : connectCtl.signal;

      // Uses LITELLM_MASTER_KEY (server-only secret) - never expose per-user virtual keys
      response = await fetch(`${env.LITELLM_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.LITELLM_MASTER_KEY}`,
          ...(params.spendLogsMetadata && {
            "x-litellm-spend-logs-metadata": JSON.stringify(
              params.spendLogsMetadata
            ),
          }),
        },
        body: JSON.stringify(requestBody),
        signal,
      });
    } catch (error) {
      // Handle fetch errors (network, timeout, abort)
      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new LlmError("LiteLLM stream aborted", "aborted");
        }
        if (error.name === "TimeoutError") {
          logger.warn(
            { requestId, traceId, model, rootCauseKind: "timeout" },
            "adapter.litellm.stream_network_error"
          );
          throw new LlmError(
            "LiteLLM stream connection timed out",
            "timeout",
            408
          );
        }
        const causeCode = (error.cause as { code?: string } | undefined)?.code;
        logger.warn(
          {
            requestId,
            traceId,
            model,
            rootCauseKind: "network",
            errorMessage: error.message,
            ...(causeCode && { causeCode }),
          },
          "adapter.litellm.stream_network_error"
        );
        throw new LlmError(
          `LiteLLM stream init failed: ${error.message}`,
          "unknown"
        );
      }
      throw new LlmError(
        "LiteLLM stream init failed: Unknown error",
        "unknown"
      );
    } finally {
      clearTimeout(connectTimer);
    }

    // Handle HTTP errors with typed LlmError (per AI_SETUP_SPEC.md)
    if (!response.ok) {
      const kind = classifyLlmErrorFromStatus(response.status);
      const responseExcerpt = await readErrorResponseExcerpt(response);
      // Operator log: includes private root cause for debugging (never sent to clients)
      logger.warn(
        {
          statusCode: response.status,
          kind,
          requestId,
          traceId,
          model,
          provider: extractProviderFromModel(model),
          responseExcerpt,
        },
        "adapter.litellm.stream_http_error"
      );
      throw new LlmError(
        `LiteLLM API error: ${response.status} ${response.statusText}`,
        kind,
        response.status
      );
    }

    // Capture response.body to prove non-null to TypeScript
    const body = response.body;
    if (!body) {
      throw new Error("LiteLLM response body is empty");
    }

    // Capture cost and call ID from headers if available immediately (unlikely for stream)
    const providerCostUsd = getProviderCostFromHeaders(response);
    const litellmCallId = getLitellmCallIdFromHeaders(response);

    // Create a deferred promise for the final result (matches completion() return type)
    type CompletionResult = Awaited<ReturnType<LlmService["completion"]>>;
    const deferred = defer<CompletionResult>();

    const stream: AsyncIterable<ChatDeltaEvent> =
      (async function* (): AsyncGenerator<ChatDeltaEvent> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let fullContent = "";
        let finalUsage:
          | {
              promptTokens: number;
              completionTokens: number;
              totalTokens: number;
            }
          | undefined;
        let finishReason: string | undefined;
        let usageCost: number | undefined; // Cost from stream usage event
        // litellmCallId (from response header) is captured above — no body-id extraction needed
        let streamCompleted = false; // Track if stream completed normally (not aborted/errored)

        // Tool call accumulation state (per ADAPTER_ASSEMBLES_TOOLCALLS invariant)
        // Accumulates fragments by index until stream ends, then assembles final.toolCalls
        const toolCallAccumulators: Map<
          number,
          { id: string; name: string; arguments: string }
        > = new Map();

        // Queue for parsed events from eventsource-parser
        const eventQueue: EventSourceMessage[] = [];

        const parser: EventSourceParser = createParser({
          onEvent(event: EventSourceMessage) {
            eventQueue.push(event);
          },
        });

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Feed decoded chunk to eventsource-parser
            const chunk = decoder.decode(value, { stream: true });
            parser.feed(chunk);

            // Process all queued events
            while (eventQueue.length > 0) {
              const event = eventQueue.shift();
              if (!event) break;
              const data = event.data;

              // TODO(stream-hang-risk): streamCompleted is only set when '[DONE]' is seen.
              // If LiteLLM/provider doesn't emit '[DONE]' but ends the stream normally,
              // the `final` promise will never resolve (hang). Current OpenRouter behavior
              // always emits '[DONE]', but this is a known fragility. Options to fix:
              // 1. Track hadErrorOrAbort flag and resolve in finally when reader ends normally
              // 2. Add timeout on `final` in higher layers to convert hangs to 'timeout' errors
              // 3. Add contract test asserting '[DONE]' is always emitted
              if (data === "[DONE]") {
                streamCompleted = true;
                yield { type: "done" } as const;
                continue;
              }

              try {
                const json = JSON.parse(data);

                // json.id (response body) intentionally ignored for billing.
                // USAGE_UNIT_IS_LITELLM_CALL_ID: header is the only source.

                // Check for provider error in response
                if (json.error) {
                  const errorMsg =
                    typeof json.error === "string"
                      ? json.error
                      : json.error.message || "Provider error";
                  const errorText = `LiteLLM stream error: ${errorMsg}`;
                  // Extract status code if available for proper error classification
                  const statusCode =
                    typeof json.error?.code === "number"
                      ? json.error.code
                      : undefined;
                  const errorKind = statusCode
                    ? classifyLlmErrorFromStatus(statusCode)
                    : "unknown";
                  // Operator log: includes private error detail for debugging
                  logger.warn(
                    {
                      statusCode,
                      kind: errorKind,
                      requestId,
                      traceId,
                      model,
                      provider: extractProviderFromModel(model),
                      litellmCallId,
                      errorDetail: scrubStringContent(
                        errorMsg.slice(0, MAX_ERROR_BODY_LOG_CHARS)
                      ),
                    },
                    "adapter.litellm.sse_error"
                  );
                  yield { type: "error", error: errorText } as const;
                  deferred.reject(
                    new LlmError(errorText, errorKind, statusCode)
                  );
                  return;
                }

                if (json.usage) {
                  finalUsage = {
                    promptTokens: json.usage.prompt_tokens,
                    completionTokens: json.usage.completion_tokens,
                    totalTokens: json.usage.total_tokens,
                  };
                  // Extract cost from usage event (stream_options: { include_usage: true })
                  if (
                    typeof json.usage.cost === "number" &&
                    Number.isFinite(json.usage.cost)
                  ) {
                    usageCost = json.usage.cost;
                  }
                }

                const choice = json.choices?.[0];
                if (choice) {
                  if (choice.finish_reason) {
                    finishReason = choice.finish_reason;
                  }

                  const content = choice.delta?.content;
                  if (content) {
                    fullContent += content;
                    yield { type: "text_delta", delta: content } as const;
                  }

                  // Parse and accumulate tool_calls deltas (OpenAI SSE format)
                  // Each delta contains index + partial id/name/arguments
                  const toolCalls = choice.delta?.tool_calls as
                    | Array<{
                        index: number;
                        id?: string;
                        type?: string;
                        function?: { name?: string; arguments?: string };
                      }>
                    | undefined;

                  if (toolCalls && Array.isArray(toolCalls)) {
                    for (const tc of toolCalls) {
                      const idx = tc.index;

                      // Initialize accumulator on first delta for this index
                      let acc = toolCallAccumulators.get(idx);
                      if (!acc) {
                        acc = { id: "", name: "", arguments: "" };
                        toolCallAccumulators.set(idx, acc);
                      }

                      // Accumulate fragments
                      if (tc.id) acc.id = tc.id;
                      if (tc.function?.name) acc.name = tc.function.name;
                      if (tc.function?.arguments)
                        acc.arguments += tc.function.arguments;

                      // Build delta event for UI streaming
                      const delta: LlmToolCallDelta = {
                        index: idx,
                        ...(tc.id && { id: tc.id }),
                        ...(tc.function && {
                          function: {
                            ...(tc.function.name && { name: tc.function.name }),
                            ...(tc.function.arguments && {
                              arguments: tc.function.arguments,
                            }),
                          },
                        }),
                      };

                      yield { type: "tool_call_delta", delta } as const;
                    }
                  }
                }
              } catch (parseError) {
                // Log malformed JSON but continue streaming (transient SSE noise)
                const errorMessage =
                  parseError instanceof Error
                    ? parseError.message
                    : "JSON parse error";
                logger.warn(
                  { dataLength: data.length },
                  `Malformed SSE data: ${errorMessage}`
                );
                // Do not yield error - continue processing remaining events
              }
            }
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.name === "AbortError") {
            // Stream aborted - reject with typed LlmError for proper telemetry
            deferred.reject(new LlmError("LiteLLM stream aborted", "aborted"));
            return;
          } else {
            // Real stream failure
            deferred.reject(error);
            return;
          }
        } finally {
          reader.releaseLock();

          // Only resolve on successful stream completion (not abort/error)
          if (streamCompleted) {
            // Extract resolved model/provider (SSE doesn't return these, use request param)
            const resolvedModel = model;
            const resolvedProvider = extractProviderFromModel(resolvedModel);
            const resolvedDisplayName = await lookupDisplayName(model);

            // Assemble final tool calls from accumulated deltas (per ADAPTER_ASSEMBLES_TOOLCALLS)
            // Only include if finishReason is "tool_calls" and we have accumulated data
            let assembledToolCalls: LlmToolCall[] | undefined;
            if (
              finishReason === "tool_calls" &&
              toolCallAccumulators.size > 0
            ) {
              assembledToolCalls = Array.from(toolCallAccumulators.entries())
                .sort(([a], [b]) => a - b) // Sort by index
                .map(
                  ([, acc]): LlmToolCall => ({
                    id: acc.id,
                    type: "function",
                    function: {
                      name: acc.name,
                      arguments: acc.arguments,
                    },
                  })
                );
            }

            // Build result object conditionally to satisfy exactOptionalPropertyTypes
            const result: CompletionResult = {
              message: { role: "assistant", content: fullContent },
              promptHash,
              resolvedProvider,
              resolvedModel,
              ...(resolvedDisplayName && { resolvedDisplayName }),
            };
            if (finalUsage) {
              result.usage = finalUsage;
            }
            if (finishReason) {
              result.finishReason = finishReason;
            }
            if (assembledToolCalls && assembledToolCalls.length > 0) {
              result.toolCalls = assembledToolCalls;
            }

            // Cost derivation priority (ACTIVITY_METRICS.md §3):
            // 1. Header (providerCostUsd from x-litellm-response-cost)
            // 2. Usage event (usageCost from stream usage.cost)
            // 3. Neither → undefined (will log CRITICAL in completion.ts)
            const derivedCost =
              typeof providerCostUsd === "number" ? providerCostUsd : usageCost;

            if (typeof derivedCost === "number") {
              result.providerCostUsd = derivedCost;
            }

            // USAGE_UNIT_IS_LITELLM_CALL_ID: header is the ONLY source.
            // Do NOT fall back to SSE chunk json.id (response body) — it may
            // differ from spend_logs.request_id. Missing header = bug.
            if (litellmCallId) {
              result.litellmCallId = litellmCallId;
            }

            // ALWAYS include providerMeta with model (SSE doesn't return this, use request param)
            result.providerMeta = {
              model: resolvedModel,
              provider: resolvedProvider,
            };

            // Sanitized adapter log (no content, bounded fields only)
            logger.info(
              {
                model: resolvedModel,
                provider: resolvedProvider,
                tokensUsed: finalUsage?.totalTokens,
                finishReason,
                hasCost: typeof derivedCost === "number",
                hasCallId: !!result.litellmCallId,
                contentLength: fullContent.length,
                toolCallCount: assembledToolCalls?.length ?? 0,
                promptHash,
              },
              "adapter.litellm.stream_result"
            );
            deferred.resolve(result);
          }
        }
      })();

    return {
      stream,
      final: deferred.promise,
    };
  }
}
