// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/ai/chat`
 * Purpose: HTTP endpoint for chat API using AI SDK Data Stream Protocol with server-authoritative thread persistence.
 * Scope: Accepts user message string, loads thread from DB, starts graph workflow, pipes SSE from Redis via createUIMessageStream. Does not persist assistant messages (execution layer handles that). Does not implement business logic.
 * Invariants:
 *   - CLIENT_SENDS_USER_ONLY: client sends single message string; server loads authoritative thread from DB
 *   - OPTIMISTIC_APPEND: two-phase save (user before execute, assistant after pump) with expectedMessageCount guard
 *   - METADATA_ON_INSERT: thread metadata (model, graphName) saved on first persist only (expectedLen === 0)
 *   - Uses AI SDK createUIMessageStream (no custom SSE)
 *   - Per ASSISTANT_FINAL_REQUIRED: reconciles truncated text_delta events with assistant_final
 *   - Per STATUS_IS_EPHEMERAL: StatusEvent maps to transient data-status chunk, never persisted
 * Side-effects: IO (HTTP request/response, DB persistence)
 * Notes: P1 wire format — createUIMessageStream + createUIMessageStreamResponse (SSE). Pure pipe — no persistence accumulator.
 * Links: Uses ai.chat.v1 contract, completion.server facade, AI SDK streaming, ThreadPersistencePort
 * @public
 */

import { isAiExecutionError } from "@cogni/ai-core";
import { toUserId } from "@cogni/ids";
import { aiChatOperation, type ChatInput } from "@cogni/node-contracts";
import { ChatValidationError } from "@cogni/node-shared";
import type { UIMessage, UIMessageChunk } from "ai";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { nanoid } from "nanoid";
import { NextResponse } from "next/server";
import { executionErrorToHttpStatus } from "@/app/_facades/ai/execution-error-mapper";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { isAccountsFeatureError } from "@/features/accounts/public";
import {
  redactSecretsInMessages,
  uiMessagesToMessageDtos,
} from "@/features/ai/public.server";
import {
  isInsufficientCreditsPortError,
  isLlmError,
  ThreadConflictError,
} from "@/ports";
import {
  aiChatStreamDurationMs,
  logRequestWarn,
  type RequestContext,
} from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Local error handler for chat route.
 * Maps domain errors to HTTP responses; returns null for unhandled errors.
 */
function handleRouteError(
  ctx: RequestContext,
  error: unknown,
  model?: string
): NextResponse | null {
  // Zod validation errors
  if (error && typeof error === "object" && "issues" in error) {
    logRequestWarn(ctx.log, error, "VALIDATION_ERROR");
    return NextResponse.json(
      { error: "Invalid input format" },
      { status: 400 }
    );
  }

  // Thread conflict (optimistic concurrency)
  if (error instanceof ThreadConflictError) {
    logRequestWarn(ctx.log, error, "THREAD_CONFLICT");
    return NextResponse.json(
      { error: "Thread conflict — please retry" },
      { status: 409 }
    );
  }

  // Port-level credit errors (thrown directly by PreflightCreditCheckDecorator
  // during stream iteration — not mapped to feature errors by the facade in
  // the streaming path)
  if (isInsufficientCreditsPortError(error)) {
    logRequestWarn(ctx.log, error, "INSUFFICIENT_CREDITS");
    return NextResponse.json(
      { error: "Insufficient credits" },
      { status: 402 }
    );
  }

  // Execution errors from Temporal+Redis boundary (serialization-safe error codes)
  if (isAiExecutionError(error)) {
    const status = executionErrorToHttpStatus(error.code);
    logRequestWarn(ctx.log, error, error.code.toUpperCase());
    return NextResponse.json({ error: error.code }, { status });
  }

  // Chat validation errors (structured via ChatValidationError)
  if (error instanceof ChatValidationError) {
    logRequestWarn(ctx.log, error, "MESSAGE_VALIDATION_ERROR");
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Abort errors
  if (error instanceof Error && error.name === "AbortError") {
    logRequestWarn(ctx.log, error, "REQUEST_TIMEOUT");
    return NextResponse.json({ error: "Request timeout" }, { status: 408 });
  }

  // LLM errors (structured via LlmError kind/status)
  // Must precede isAccountsFeatureError — both use duck-typed .kind field
  if (isLlmError(error)) {
    if (error.kind === "timeout") {
      logRequestWarn(ctx.log, error, "REQUEST_TIMEOUT");
      return NextResponse.json({ error: "Request timeout" }, { status: 408 });
    }
    if (error.kind === "rate_limited" || error.status === 429) {
      logRequestWarn(ctx.log, error, "RATE_LIMIT_EXCEEDED");
      return NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: 429 }
      );
    }
    if (error.status === 404) {
      logRequestWarn(ctx.log, error, "MODEL_UNAVAILABLE");
      return NextResponse.json(
        { code: "MODEL_UNAVAILABLE", model },
        { status: 409 }
      );
    }
    // Catch-all for other LLM errors (provider_4xx, provider_5xx, unknown)
    logRequestWarn(ctx.log, error, "LLM_SERVICE_UNAVAILABLE");
    return NextResponse.json(
      { error: "AI service temporarily unavailable" },
      { status: 503 }
    );
  }

  // Accounts feature errors
  if (isAccountsFeatureError(error)) {
    if (error.kind === "INSUFFICIENT_CREDITS") {
      logRequestWarn(ctx.log, error, "INSUFFICIENT_CREDITS");
      return NextResponse.json(
        { error: "Insufficient credits" },
        { status: 402 }
      );
    }
    if (error.kind === "BILLING_ACCOUNT_NOT_FOUND") {
      logRequestWarn(ctx.log, error, "BILLING_ACCOUNT_NOT_FOUND");
      return NextResponse.json({ error: "Account not found" }, { status: 403 });
    }
    if (error.kind === "VIRTUAL_KEY_NOT_FOUND") {
      logRequestWarn(ctx.log, error, "VIRTUAL_KEY_NOT_FOUND");
      return NextResponse.json(
        { error: "Virtual key not found" },
        { status: 403 }
      );
    }
    // Fallback for GENERIC
    logRequestWarn(ctx.log, error, "ACCOUNT_ERROR");
    return NextResponse.json(
      { error: error.kind === "GENERIC" ? error.message : "Account error" },
      { status: 400 }
    );
  }

  return null; // Unhandled → let wrapper catch as 500
}

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "ai.chat", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    let input: ChatInput | undefined;
    try {
      // Parse JSON body
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json(
          { error: "Invalid JSON body" },
          { status: 400 }
        );
      }

      // Validate input with contract (safeParse for better error handling)
      const inputParseResult = aiChatOperation.input.safeParse(body);
      if (!inputParseResult.success) {
        logRequestWarn(ctx.log, inputParseResult.error, "VALIDATION_ERROR");
        return NextResponse.json(
          {
            error: "Invalid input",
            details: inputParseResult.error.flatten(),
          },
          { status: 400 }
        );
      }
      input = inputParseResult.data;

      // --- CLIENT_SENDS_USER_ONLY: message comes directly from input ---
      const userText = input.message;

      const handlerStartMs = performance.now();

      // modelRef validation is structural (Zod schema on contract).
      // Catalog-based allowlist check is deferred to execution-time preflight.

      if (!sessionUser) throw new Error("sessionUser required");

      // --- stateKey lifecycle ---
      const stateKey = input.stateKey ?? nanoid(21);
      const userId = toUserId(sessionUser.id);
      const threadPersistence = getContainer().threadPersistenceForUser(userId);

      // --- Load authoritative thread from DB ---
      let existingThread = await threadPersistence.loadThread(
        sessionUser.id,
        stateKey
      );
      let expectedLen = existingThread.length;

      // Build user UIMessage
      const userUIMessage: UIMessage = {
        id: nanoid(),
        role: "user",
        parts: [{ type: "text" as const, text: userText }],
      };

      // --- Phase 1: persist user message before execution (optimistic) ---
      // Metadata (model, graphName) saved on INSERT only — first persist creates the thread row.
      const threadMetadata =
        expectedLen === 0
          ? { model: input.modelRef.modelId, graphName: input.graphName }
          : undefined;

      let threadWithUser = [...existingThread, userUIMessage];
      try {
        await threadPersistence.saveThread(
          sessionUser.id,
          stateKey,
          redactSecretsInMessages(threadWithUser),
          expectedLen,
          threadMetadata
        );
      } catch (e) {
        if (!(e instanceof ThreadConflictError)) throw e;
        // Retry once: reload + re-append
        existingThread = await threadPersistence.loadThread(
          sessionUser.id,
          stateKey
        );
        expectedLen = existingThread.length;
        threadWithUser = [...existingThread, userUIMessage];
        await threadPersistence.saveThread(
          sessionUser.id,
          stateKey,
          redactSecretsInMessages(threadWithUser),
          expectedLen,
          expectedLen === 0 ? threadMetadata : undefined
        );
        // If this throws ThreadConflictError again, handleRouteError catches → 409
      }
      const expectedLenAfterUser = threadWithUser.length;

      ctx.log.info(
        {
          reqId: ctx.reqId,
          userId: sessionUser.id,
          requestedModel: input.modelRef.modelId,
          providerKey: input.modelRef.providerKey,
          connectionId: input.modelRef.connectionId ?? null,
          threadMessages: expectedLenAfterUser,
          stateKey,
        },
        "ai.chat_received"
      );

      // --- Convert persisted thread → DTOs for execution ---
      const { completionStream } = await import(
        "@/app/_facades/ai/completion.server"
      );
      const messageDtos = uiMessagesToMessageDtos(threadWithUser);

      const streamStartMs = performance.now();
      const idempotencyKey =
        request.headers.get("idempotency-key") ?? undefined;

      const { stream: deltaStream, final } = await completionStream(
        {
          messages: messageDtos,
          modelRef: input.modelRef,
          sessionUser,
          abortSignal: request.signal,
          graphName: input.graphName,
          stateKey,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
        ctx
      );

      ctx.log.info(
        {
          reqId: ctx.reqId,
          handlerMs: performance.now() - handlerStartMs,
          resolvedModel: input.modelRef.modelId,
          stream: true,
        },
        "ai.chat_response_started"
      );

      // --- SSE reconciliation state (display only, NOT for persistence) ---
      // Per PERSIST_AFTER_PUMP: assistant persistence moved to execution layer (internal API route).
      // These variables track text_delta accumulation solely for SSE reconciliation:
      // if assistant_final has more content than deltas delivered, append the remainder to the SSE stream.
      let accumulatedText = "";
      let assistantFinalContent: string | undefined;

      // --- Stream response via AI SDK Data Stream Protocol (SSE) ---
      const textPartId = nanoid();
      let textBlockOpen = false;

      const uiStream = createUIMessageStream({
        execute: async ({ writer }) => {
          try {
            let eventSeq = 0;

            for await (const event of deltaStream) {
              if (request.signal.aborted) break;
              eventSeq++;

              if (event.type === "text_delta") {
                accumulatedText += event.delta;
                if (!textBlockOpen) {
                  writer.write({ type: "text-start", id: textPartId });
                  textBlockOpen = true;
                }
                writer.write({
                  type: "text-delta",
                  delta: event.delta,
                  id: textPartId,
                });
              } else if (event.type === "assistant_final") {
                assistantFinalContent = event.content;
                ctx.log.debug(
                  {
                    seq: eventSeq,
                    accLen: accumulatedText.length,
                    finalLen: event.content.length,
                  },
                  "ai.chat_assistant_final_received"
                );
              } else if (event.type === "tool_call_start") {
                // Close text block before tool call
                if (textBlockOpen) {
                  writer.write({ type: "text-end", id: textPartId });
                  textBlockOpen = false;
                }

                ctx.log.info(
                  { toolCallId: event.toolCallId, toolName: event.toolName },
                  "tool_call_start received"
                );

                writer.write({
                  type: "tool-input-start",
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                } as UIMessageChunk);

                if (event.args != null) {
                  writer.write({
                    type: "tool-input-available",
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    input: event.args,
                  } as UIMessageChunk);
                }
              } else if (event.type === "tool_call_result") {
                writer.write({
                  type: "tool-output-available",
                  toolCallId: event.toolCallId,
                  output: event.result,
                } as UIMessageChunk);

                ctx.log.info(
                  { toolCallId: event.toolCallId },
                  "tool_call_result completed"
                );
              } else if (event.type === "status") {
                // STATUS_IS_EPHEMERAL: transient data part, never persisted in UIMessage
                // STATUS_BEST_EFFORT: safe to skip if stream is backpressured
                writer.write({
                  type: "data-status",
                  data: {
                    phase: event.phase,
                    ...(event.label ? { label: event.label } : {}),
                  },
                  transient: true,
                } as UIMessageChunk);
              }
            }

            // Reconcile: if assistant_final has text beyond what deltas delivered,
            // append the remainder.
            if (
              assistantFinalContent !== undefined &&
              assistantFinalContent.length > accumulatedText.length &&
              assistantFinalContent.startsWith(accumulatedText)
            ) {
              const remainder = assistantFinalContent.slice(
                accumulatedText.length
              );
              ctx.log.info(
                {
                  accLen: accumulatedText.length,
                  finalLen: assistantFinalContent.length,
                  remainderLen: remainder.length,
                },
                "ai.chat_reconcile_appending_remainder"
              );
              if (!textBlockOpen) {
                writer.write({ type: "text-start", id: textPartId });
                textBlockOpen = true;
              }
              writer.write({
                type: "text-delta",
                delta: remainder,
                id: textPartId,
              });
            } else if (
              assistantFinalContent !== undefined &&
              assistantFinalContent !== accumulatedText &&
              !assistantFinalContent.startsWith(accumulatedText)
            ) {
              ctx.log.warn(
                {
                  accLen: accumulatedText.length,
                  finalLen: assistantFinalContent.length,
                  accTail: accumulatedText.slice(-40),
                  finalTail: assistantFinalContent.slice(-40),
                },
                "ai.chat_reconcile_content_diverged"
              );
            }

            if (
              assistantFinalContent === undefined &&
              accumulatedText.length > 0
            ) {
              ctx.log.error(
                {
                  accLen: accumulatedText.length,
                  eventCount: eventSeq,
                },
                "ai.chat_assistant_final_missing — ASSISTANT_FINAL_REQUIRED violated"
              );
            }

            // Close text block if still open
            if (textBlockOpen) {
              writer.write({ type: "text-end", id: textPartId });
              textBlockOpen = false;
            }

            // Flush barrier
            await new Promise((r) => setTimeout(r, 0));

            // Wait for final result (billing) with 15s timeout
            const FINAL_TIMEOUT_MS = 15000;
            const finalTimeout = new Promise<{ ok: false; error: "timeout" }>(
              (resolve) =>
                setTimeout(
                  () => resolve({ ok: false, error: "timeout" }),
                  FINAL_TIMEOUT_MS
                )
            );

            const result = await Promise.race([final, finalTimeout]);

            if (result.ok) {
              // AI SDK uiMessageChunkSchema uses z.strictObject for finish —
              // only finishReason and messageMetadata are allowed (no usage).
              writer.write({
                type: "finish",
                finishReason: result.finishReason as
                  | "stop"
                  | "length"
                  | "tool-calls"
                  | "content-filter"
                  | "other"
                  | "error",
              });
            } else {
              ctx.log.warn(
                { reqId: ctx.reqId, error: result.error },
                "ai.chat_stream_final_error"
              );
              writer.write({
                type: "error",
                errorText: `Stream finalization failed: ${result.error}`,
              });
            }
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
              ctx.log.info({ reqId: ctx.reqId }, "ai.chat_client_aborted");
            } else {
              ctx.log.error({ err: error }, "Stream error in route");
              throw error;
            }
          } finally {
            const streamMs = performance.now() - streamStartMs;
            aiChatStreamDurationMs.observe(streamMs);
            ctx.log.info(
              { reqId: ctx.reqId, streamMs },
              "ai.chat_stream_closed"
            );
          }
        },
      });

      // --- Phase 2 (assistant persistence) moved to execution layer ---
      // Per PERSIST_AFTER_PUMP: the internal API route persists the assistant message
      // after draining the full executor stream. This route is a pure SSE pipe.

      // Return SSE response with stateKey header for thread continuity
      // Wrap in NextResponse: createUIMessageStreamResponse returns Response,
      // but wrapRouteHandlerWithLogging expects NextResponse.
      const sseResponse = createUIMessageStreamResponse({
        stream: uiStream,
        headers: { "X-State-Key": stateKey },
      });
      return new NextResponse(sseResponse.body, {
        status: sseResponse.status,
        headers: sseResponse.headers,
      });
    } catch (error) {
      const errorResponse = handleRouteError(
        ctx,
        error,
        input?.modelRef?.modelId
      );
      if (errorResponse) return errorResponse;
      throw error; // Unhandled → wrapper catches
    }
  }
);
