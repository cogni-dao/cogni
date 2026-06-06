// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/ai/completion.server`
 * Purpose: App-layer coordinator for AI completion - session → billing account, starts Temporal workflow, subscribes to Redis stream.
 * Scope: Resolves session user to billing account, starts GraphRunWorkflow via Temporal, subscribes to Redis RunStream for AiEvents. Does not contain business logic or HTTP concerns.
 * Invariants:
 *   - ONE_RUN_EXECUTION_PATH: Both chatCompletion() and completionStream() start GraphRunWorkflow via Temporal
 *   - Only app layer imports this; routes call this, not features/* directly
 *   - Must import features via public.ts ONLY (never import from services subdirectories)
 *   - NEVER import adapters (use bootstrap factories instead)
 *   - Per CREDITS_ENFORCED_AT_EXECUTION_PORT: preflight credit check handled by decorator in execution layer
 *   - Validates billing account before delegation; propagates feature errors
 *   - IDEMPOTENT_WORKFLOW_START: swallows WorkflowExecutionAlreadyStartedError for safe retries
 *   - TERMINAL_EVENT_TRACKING: stream pump tracks sawTerminal flag; failStream only fires when no done/error event received
 * Side-effects: IO (Temporal workflow start, Redis stream subscription)
 * Notes: chatCompletion() delegates to completionStream() and collects response server-side.
 *   Returns OpenAI-compatible ChatCompletion format.
 * Links: Called by API routes, GraphRunWorkflow (scheduler-worker), RunStreamPort (Redis)
 * @public
 */

import { createHash } from "node:crypto";
import { AiExecutionError } from "@cogni/ai-core";
import { toUserId } from "@cogni/ids";
import type { ChatCompletionOutput, ChatMessage } from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { EVENT_NAMES } from "@cogni/node-shared";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import {
  getContainer,
  getTemporalWorkflowClient,
  resolveAiAdapterDeps,
} from "@/bootstrap/container";
import { mapAccountsPortErrorToFeature } from "@/features/accounts/public";
// Types from client-safe barrel (types only, no runtime)
import type { AiEvent, StreamFinalResult } from "@/features/ai/public";
// Import from public.server.ts - never from services/* directly (dep-cruiser enforced)
import type { MessageDto } from "@/features/ai/public.server";
import { getOrCreateBillingAccountForUser } from "@/lib/auth/mapping";
import {
  isBillingAccountNotFoundPortError,
  isInsufficientCreditsPortError,
  isVirtualKeyNotFoundPortError,
} from "@/ports";
import { getNodeId } from "@/shared/config";
import type { RequestContext } from "@/shared/observability";

// ─────────────────────────────────────────────────────────────────────────────
// Default graph for requests that don't specify one
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_GRAPH_NAME = "langgraph:default";

// ─────────────────────────────────────────────────────────────────────────────
// Message conversion: OpenAI → internal MessageDto
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert OpenAI ChatMessage array to internal MessageDto array.
 * Maps OpenAI field names (snake_case) to internal format (camelCase).
 */
export function chatMessagesToDtos(messages: ChatMessage[]): MessageDto[] {
  return messages.map((msg): MessageDto => {
    if (msg.role === "system") {
      return { role: "system", content: msg.content };
    }
    if (msg.role === "user") {
      return { role: "user", content: msg.content };
    }
    if (msg.role === "tool") {
      return {
        role: "tool",
        content: msg.content,
        toolCallId: msg.tool_call_id,
      };
    }
    // assistant
    return {
      role: "assistant",
      content: msg.content ?? "",
      ...(msg.tool_calls && msg.tool_calls.length > 0
        ? {
            toolCalls: msg.tool_calls.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            })),
          }
        : {}),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export interface CompletionInput {
  messages: MessageDto[];
  /** Fully-resolved model reference (provider + model + optional connection) */
  modelRef: import("@cogni/ai-core").ModelRef;
  sessionUser: SessionUser;
  /** Graph name or fully-qualified graphId to execute */
  graphName: string;
  /** Conversation state key for multi-turn conversations */
  stateKey?: string;
  /** Idempotency key for workflow start dedupe */
  idempotencyKey?: string;
}

function toDeterministicRunId(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const p1 = hex.slice(0, 8);
  const p2 = hex.slice(8, 12);
  const p3 = `4${hex.slice(13, 16)}`;
  const variantNibble = (
    (parseInt(hex.slice(16, 17), 16) & 0x3) |
    0x8
  ).toString(16);
  const p4 = `${variantNibble}${hex.slice(17, 20)}`;
  const p5 = hex.slice(20, 32);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Finish reason mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map internal finish reason to OpenAI-compatible finish_reason.
 */
export function toOpenAiFinishReason(
  reason: string
): "stop" | "length" | "tool_calls" | "content_filter" {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// chatCompletion: Non-streaming, returns OpenAI ChatCompletion format
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatCompletionInput {
  messages: ChatMessage[];
  modelRef: import("@cogni/ai-core").ModelRef;
  sessionUser: SessionUser;
  /** Graph name or fully-qualified graphId to execute */
  graphName?: string;
  /** Conversation state key for multi-turn conversations */
  stateKey?: string;
  /** Idempotency key for workflow start dedupe */
  idempotencyKey?: string;
}

/**
 * Non-streaming AI completion returning OpenAI ChatCompletion format.
 * Per UNIFIED_GRAPH_EXECUTOR: delegates to completionStream() and collects response server-side.
 * This ensures billing flows through the unified Temporal execution path.
 */
export async function chatCompletion(
  input: ChatCompletionInput,
  ctx: RequestContext
): Promise<ChatCompletionOutput> {
  const messageDtos = chatMessagesToDtos(input.messages);
  const graphName = input.graphName ?? DEFAULT_GRAPH_NAME;

  // Delegate to streaming path (UNIFIED_GRAPH_EXECUTOR)
  const { stream, final } = await completionStream(
    {
      messages: messageDtos,
      modelRef: input.modelRef,
      sessionUser: input.sessionUser,
      graphName,
      ...(input.stateKey ? { stateKey: input.stateKey } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
    ctx
  );

  // Collect text deltas server-side
  const textParts: string[] = [];
  try {
    for await (const event of stream) {
      if (event.type === "text_delta") {
        textParts.push(event.delta);
      }
    }

    // Await final to ensure terminal event received
    const result = await final;

    if (!result.ok) {
      // TODO: proper error translation from AiExecutionErrorCode → domain errors.
      // Currently AiExecutionError is caught below and re-mapped for known codes.
      throw new AiExecutionError(result.error);
    }

    const content = textParts.join("");
    const finishReason = toOpenAiFinishReason(result.finishReason);

    return {
      id: `chatcmpl-${result.requestId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: input.modelRef.modelId,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(finishReason === "tool_calls" &&
            result.ok &&
            "toolCalls" in result &&
            result.toolCalls
              ? {
                  tool_calls: result.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function" as const,
                    function: {
                      name: tc.function.name,
                      arguments: tc.function.arguments,
                    },
                  })),
                }
              : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        total_tokens: result.usage.promptTokens + result.usage.completionTokens,
      },
    };
  } catch (error) {
    // Map port-level errors to feature errors for route handler.
    if (
      isInsufficientCreditsPortError(error) ||
      isBillingAccountNotFoundPortError(error) ||
      isVirtualKeyNotFoundPortError(error)
    ) {
      throw mapAccountsPortErrorToFeature(error);
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// chatCompletionStream: Streaming, returns AiEvent stream for SSE conversion
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatCompletionStreamInput {
  messages: ChatMessage[];
  modelRef: import("@cogni/ai-core").ModelRef;
  sessionUser: SessionUser;
  /** Graph name or fully-qualified graphId to execute */
  graphName?: string;
  /** Conversation state key for multi-turn conversations */
  stateKey?: string;
  /** Idempotency key for workflow start dedupe */
  idempotencyKey?: string;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/**
 * Streaming AI completion. Returns an AiEvent stream and final promise.
 * The route handler converts AiEvents to OpenAI SSE chunk format.
 */
export async function chatCompletionStream(
  input: ChatCompletionStreamInput,
  ctx: RequestContext
): Promise<{
  stream: AsyncIterable<AiEvent>;
  final: Promise<StreamFinalResult>;
}> {
  const messageDtos = chatMessagesToDtos(input.messages);
  const graphName = input.graphName ?? DEFAULT_GRAPH_NAME;

  return completionStream(
    {
      messages: messageDtos,
      modelRef: input.modelRef,
      sessionUser: input.sessionUser,
      graphName,
      ...(input.stateKey ? { stateKey: input.stateKey } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    },
    ctx
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// completionStream: shared core (used by chat route AND completions route)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stream chat completion via AI streaming service.
 * App facade responsibility: session → billing account, caller creation, error mapping.
 * NO business logic here - delegates to feature layer via public.ts.
 */
export async function completionStream(
  input: CompletionInput & { abortSignal?: AbortSignal },
  ctx: RequestContext
): Promise<{
  stream: AsyncIterable<AiEvent>;
  final: Promise<StreamFinalResult>;
}> {
  const userId = toUserId(input.sessionUser.id);
  const { accountService } = resolveAiAdapterDeps(userId);

  const billingAccount = await getOrCreateBillingAccountForUser(
    accountService,
    {
      userId: input.sessionUser.id,
      ...(input.sessionUser.walletAddress
        ? { walletAddress: input.sessionUser.walletAddress }
        : {}),
    }
  );

  const graphId = input.graphName.includes(":")
    ? input.graphName
    : `langgraph:${input.graphName}`;
  const idempotencyKey = input.idempotencyKey ?? `api:${ctx.reqId}`;
  const workflowId = `graph-run:${billingAccount.id}:${idempotencyKey}`;
  const runId = toDeterministicRunId(`${workflowId}:${graphId}`);

  const { client: workflowClient, taskQueue } =
    await getTemporalWorkflowClient();
  try {
    await workflowClient.start("GraphRunWorkflow", {
      taskQueue,
      workflowId,
      args: [
        {
          nodeId: getNodeId(),
          graphId,
          executionGrantId: null,
          input: {
            messages: input.messages,
            modelRef: input.modelRef,
            stateKey: input.stateKey,
            actorUserId: input.sessionUser.id,
            billingAccountId: billingAccount.id,
            virtualKeyId: billingAccount.defaultVirtualKeyId,
          },
          runKind: "user_immediate" as const,
          triggerSource: "api",
          triggerRef: idempotencyKey,
          requestedBy: input.sessionUser.id,
          runId,
        },
      ],
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
      throw error;
    }
  }

  const runStream = getContainer().runStream;
  const signal = input.abortSignal ?? new AbortController().signal;
  const rawSubscription = runStream.subscribe(runId, signal);
  const iterator = rawSubscription[Symbol.asyncIterator]();

  // First-event peek: if the first event is a terminal error (e.g. insufficient_credits),
  // throw AiExecutionError BEFORE the caller commits SSE headers.
  // Mid-stream errors are fine — 200 is already sent, error arrives in the stream.
  const first = await iterator.next();
  if (first.done) {
    throw new AiExecutionError("internal");
  }
  const firstEvent = first.value.event;
  if (firstEvent.type === "error") {
    throw new AiExecutionError(firstEvent.error);
  }

  let resolveFinal: ((value: StreamFinalResult) => void) | undefined;
  const final = new Promise<StreamFinalResult>((resolve) => {
    resolveFinal = resolve;
  });

  const stream = (async function* (): AsyncIterable<AiEvent> {
    const toolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];

    // Process first event (already peeked and validated as non-error)
    function processEvent(event: AiEvent) {
      if (event.type === "tool_call_start") {
        toolCalls.push({
          id: event.toolCallId,
          type: "function",
          function: {
            name: event.toolName,
            arguments: JSON.stringify(event.args),
          },
        });
      }
      if (event.type === "done") {
        resolveFinal?.({
          ok: true,
          requestId: runId,
          usage: event.usage ?? { promptTokens: 0, completionTokens: 0 },
          finishReason:
            event.finishReason ??
            (toolCalls.length > 0 ? "tool_calls" : "stop"),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
      } else if (event.type === "error") {
        resolveFinal?.({
          ok: false,
          requestId: runId,
          error: event.error,
        });
      }
    }

    // Yield peeked first event
    processEvent(firstEvent);
    yield firstEvent;

    function failStream(errorCode: string) {
      ctx.log.warn(
        {
          event: EVENT_NAMES.AI_RELAY_PUMP_ERROR,
          reqId: ctx.reqId,
          runId,
          errorCode,
        },
        EVENT_NAMES.AI_RELAY_PUMP_ERROR
      );
      resolveFinal?.({ ok: false, requestId: runId, error: "internal" });
    }

    // Continue with remaining events
    let sawTerminal = false;
    try {
      let next = await iterator.next();
      while (!next.done) {
        const event = next.value.event;
        if (event.type === "usage_report") {
          next = await iterator.next();
          continue;
        }
        if (event.type === "done" || event.type === "error") {
          sawTerminal = true;
        }
        processEvent(event);
        yield event;
        next = await iterator.next();
      }
      if (!sawTerminal) {
        failStream("stream_ended_no_terminal");
      }
    } catch {
      failStream("stream_subscribe_error");
    }
  })();

  return { stream, final };
}
