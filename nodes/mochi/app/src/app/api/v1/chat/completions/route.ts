// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/chat/completions`
 * Purpose: OpenAI-compatible Chat Completions HTTP endpoint (POST /v1/chat/completions).
 * Scope: Parse OpenAI request, delegate to facade, return OpenAI response format (streaming + non-streaming). Does not implement business logic.
 * Invariants:
 *   - Request/response format matches OpenAI Chat Completions API
 *   - Streaming uses SSE with `data: {json}\n\n` lines and `data: [DONE]\n\n` terminator
 *   - Error responses use OpenAI error format: `{ error: { message, type, param, code } }`
 *   - All execution flows through UNIFIED_GRAPH_EXECUTOR via facade
 * Side-effects: IO (HTTP request/response)
 * Links: Uses chatCompletionsContract, delegates to completion facade
 * @public
 */

import { isAiExecutionError } from "@cogni/ai-core";
import {
  type ChatCompletionChunk,
  chatCompletionsContract,
} from "@cogni/node-contracts";
import { ChatValidationError } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import {
  chatCompletion,
  chatCompletionStream,
  toOpenAiFinishReason,
} from "@/app/_facades/ai/completion.server";
import { executionErrorToOpenAiError } from "@/app/_facades/ai/execution-error-mapper";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { isAccountsFeatureError } from "@/features/accounts/public";
import type { AiEvent, StreamFinalResult } from "@/features/ai/public";
import { isLlmError } from "@/ports";
import {
  EVENT_NAMES,
  logEvent,
  logRequestWarn,
  type RequestContext,
} from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// Error helpers: OpenAI-compatible error format
// ─────────────────────────────────────────────────────────────────────────────

function openAiError(
  message: string,
  type: string,
  status: number,
  code: string | null = null,
  param: string | null = null
): NextResponse {
  return NextResponse.json(
    { error: { message, type, param, code } },
    { status }
  );
}

/**
 * Map domain errors to OpenAI-compatible error responses.
 */
function handleRouteError(
  ctx: RequestContext,
  error: unknown
): NextResponse | null {
  // Zod validation errors
  if (error && typeof error === "object" && "issues" in error) {
    logRequestWarn(ctx.log, error, "VALIDATION_ERROR");
    return openAiError(
      "Invalid request: check your request body",
      "invalid_request_error",
      400
    );
  }

  // Chat validation errors (structured via ChatValidationError)
  if (error instanceof ChatValidationError) {
    logRequestWarn(ctx.log, error, "MESSAGE_VALIDATION_ERROR");
    return openAiError(error.message, "invalid_request_error", 400);
  }

  // Abort errors
  if (error instanceof Error && error.name === "AbortError") {
    logRequestWarn(ctx.log, error, "REQUEST_TIMEOUT");
    return openAiError("Request timed out", "timeout_error", 408);
  }

  // LLM errors (structured via LlmError kind/status)
  // Must precede isAccountsFeatureError — both use duck-typed .kind field
  if (isLlmError(error)) {
    if (error.kind === "timeout") {
      logRequestWarn(ctx.log, error, "REQUEST_TIMEOUT");
      return openAiError("Request timed out", "timeout_error", 408);
    }
    if (error.kind === "rate_limited" || error.status === 429) {
      logRequestWarn(ctx.log, error, "RATE_LIMIT_EXCEEDED");
      return openAiError(
        "Rate limit exceeded. Please retry after a brief wait.",
        "rate_limit_error",
        429,
        "rate_limit_exceeded"
      );
    }
    if (error.status === 404) {
      logRequestWarn(ctx.log, error, "MODEL_NOT_FOUND");
      return openAiError(
        "The model does not exist or you do not have access to it.",
        "invalid_request_error",
        404,
        "model_not_found",
        "model"
      );
    }
    // Catch-all for other LLM errors (provider_4xx, provider_5xx, unknown)
    logRequestWarn(ctx.log, error, "LLM_SERVICE_UNAVAILABLE");
    return openAiError(
      "The server is temporarily unable to process your request. Please retry.",
      "server_error",
      503
    );
  }

  // Accounts feature errors
  if (isAccountsFeatureError(error)) {
    if (error.kind === "INSUFFICIENT_CREDITS") {
      logRequestWarn(ctx.log, error, "INSUFFICIENT_CREDITS");
      return openAiError(
        "You exceeded your current quota. Please check your plan and billing details.",
        "insufficient_quota",
        429,
        "insufficient_quota"
      );
    }
    if (error.kind === "BILLING_ACCOUNT_NOT_FOUND") {
      logRequestWarn(ctx.log, error, "BILLING_ACCOUNT_NOT_FOUND");
      return openAiError(
        "No billing account found. Please set up billing.",
        "invalid_request_error",
        403,
        "billing_not_found"
      );
    }
    if (error.kind === "VIRTUAL_KEY_NOT_FOUND") {
      logRequestWarn(ctx.log, error, "VIRTUAL_KEY_NOT_FOUND");
      return openAiError(
        "API key not found or invalid.",
        "invalid_request_error",
        403,
        "invalid_api_key"
      );
    }
    logRequestWarn(ctx.log, error, "ACCOUNT_ERROR");
    return openAiError(
      error.kind === "GENERIC"
        ? (error.message ?? "Account error")
        : "Account error",
      "invalid_request_error",
      400
    );
  }

  // Execution errors from Temporal+Redis boundary (serialization-safe error codes)
  if (isAiExecutionError(error)) {
    const { status, message, type } = executionErrorToOpenAiError(error.code);
    logRequestWarn(ctx.log, error, error.code.toUpperCase());
    return openAiError(message, type, status);
  }

  return null; // Unhandled → let wrapper catch as 500
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE streaming helpers
// ─────────────────────────────────────────────────────────────────────────────

function sseEncode(data: string): string {
  return `data: ${data}\n\n`;
}

/**
 * Build a ReadableStream that converts AiEvents to OpenAI SSE chunks.
 */
function createOpenAiSseStream(
  aiStream: AsyncIterable<AiEvent>,
  final: Promise<StreamFinalResult>,
  model: string,
  completionId: string,
  created: number,
  includeUsage: boolean,
  log: RequestContext["log"]
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        // First chunk: announce role
        const firstChunk: ChatCompletionChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: null,
            },
          ],
        };
        controller.enqueue(
          encoder.encode(sseEncode(JSON.stringify(firstChunk)))
        );

        // Stream content and tool call chunks
        let toolCallIndex = 0;
        for await (const event of aiStream) {
          if (event.type === "text_delta") {
            const chunk: ChatCompletionChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: event.delta },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(
              encoder.encode(sseEncode(JSON.stringify(chunk)))
            );
          } else if (event.type === "tool_call_start") {
            // Emit tool call with full arguments in one chunk (AiEvent provides complete args)
            const currentIndex = toolCallIndex++;
            const chunk: ChatCompletionChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: currentIndex,
                        id: event.toolCallId,
                        type: "function" as const,
                        function: {
                          name: event.toolName,
                          arguments: JSON.stringify(event.args),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(
              encoder.encode(sseEncode(JSON.stringify(chunk)))
            );
          } else if (event.type === "status") {
            const chunk: ChatCompletionChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: null }],
              cogni_status: {
                phase: event.phase,
                ...(event.label ? { label: event.label } : {}),
              },
            };
            controller.enqueue(
              encoder.encode(sseEncode(JSON.stringify(chunk)))
            );
          }
          // done/error/tool_call_result events are terminal or internal — handled via final promise below
        }

        // Await final result for finish_reason and usage
        const result = await final;
        const finishReason = result.ok
          ? toOpenAiFinishReason(result.finishReason)
          : "stop";

        if (!result.ok) {
          log.error({ error: result.error }, "Stream completed with error");
        }

        logEvent(log, EVENT_NAMES.AI_COMPLETION, {
          reqId: completionId.replace("chatcmpl-", ""),
          routeId: "chat.completions",
          streaming: true,
          model,
          outcome: result.ok ? "success" : "error",
          finishReason,
          ...(result.ok
            ? {
                promptTokens: result.usage.promptTokens,
                completionTokens: result.usage.completionTokens,
              }
            : {}),
        });

        // Final chunk with finish_reason
        const finalChunk: ChatCompletionChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
            },
          ],
        };
        controller.enqueue(
          encoder.encode(sseEncode(JSON.stringify(finalChunk)))
        );

        // Usage chunk (if requested via stream_options.include_usage)
        if (includeUsage && result.ok) {
          const usageChunk: ChatCompletionChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            usage: {
              prompt_tokens: result.usage.promptTokens,
              completion_tokens: result.usage.completionTokens,
              total_tokens:
                result.usage.promptTokens + result.usage.completionTokens,
            },
          };
          controller.enqueue(
            encoder.encode(sseEncode(JSON.stringify(usageChunk)))
          );
        }

        // Terminate with [DONE]
        controller.enqueue(encoder.encode(sseEncode("[DONE]")));
        controller.close();
      } catch (error) {
        // On error, emit a final error chunk and close
        const errorChunk: ChatCompletionChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        };
        controller.enqueue(
          encoder.encode(sseEncode(JSON.stringify(errorChunk)))
        );
        controller.enqueue(encoder.encode(sseEncode("[DONE]")));
        controller.close();
        // Log the error — wrapper can't catch errors from inside a ReadableStream
        log.error({ error }, "SSE stream error");
      }
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handler
// ─────────────────────────────────────────────────────────────────────────────

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "chat.completions",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    try {
      // Parse JSON body
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return openAiError(
          "Could not parse JSON body",
          "invalid_request_error",
          400
        );
      }

      // Validate input with OpenAI-compatible contract
      const parseResult = chatCompletionsContract.input.safeParse(body);
      if (!parseResult.success) {
        logRequestWarn(ctx.log, parseResult.error, "VALIDATION_ERROR");
        return openAiError(
          parseResult.error.issues
            .map(
              (e) =>
                `${(e.path as Array<string | number>).join(".")}: ${e.message}`
            )
            .join("; "),
          "invalid_request_error",
          400
        );
      }
      const input = parseResult.data;

      if (!sessionUser) throw new Error("sessionUser required");

      const isStreaming = input.stream === true;
      const graphName = input.graph_name;
      const idempotencyKey =
        request.headers.get("idempotency-key") ?? undefined;

      if (isStreaming) {
        // ── Streaming path ──────────────────────────────────────────────
        const modelRef = {
          providerKey: "platform" as const,
          modelId: input.model,
        };
        const { stream, final } = await chatCompletionStream(
          {
            messages: input.messages,
            modelRef,
            sessionUser,
            ...(graphName ? { graphName } : {}),
            abortSignal: request.signal,
            ...(idempotencyKey ? { idempotencyKey } : {}),
          },
          ctx
        );

        const completionId = `chatcmpl-${ctx.reqId}`;
        const created = Math.floor(Date.now() / 1000);
        const includeUsage = input.stream_options?.include_usage === true;

        const sseStream = createOpenAiSseStream(
          stream,
          final,
          modelRef.modelId,
          completionId,
          created,
          includeUsage,
          ctx.log
        );

        return new NextResponse(sseStream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      // ── Non-streaming path ──────────────────────────────────────────
      const modelRef = {
        providerKey: "platform" as const,
        modelId: input.model,
      };
      const result = await chatCompletion(
        {
          messages: input.messages,
          modelRef,
          sessionUser,
          ...(graphName ? { graphName } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
        ctx
      );

      logEvent(ctx.log, EVENT_NAMES.AI_COMPLETION, {
        reqId: ctx.reqId,
        routeId: "chat.completions",
        streaming: false,
        model: input.model,
        outcome: "success",
        finishReason: result.choices[0]?.finish_reason ?? "stop",
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
      });

      return NextResponse.json(result);
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error; // Unhandled → wrapper catches
    }
  }
);
