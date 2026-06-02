// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/langgraph/dev/stream-translator`
 * Purpose: Translates LangGraph SDK stream events to AiEvents.
 * Scope: Converts chunk.event + chunk.data from SDK to text_delta, tool_call_start, tool_call_result, assistant_final, usage_report, done. Does NOT handle reconnection or run resumption.
 * Invariants:
 *   - SDK_CHUNK_SHAPE: SDK uses chunk.event + chunk.data (not event.type)
 *   - AI_CORE_IS_CANONICAL_OUTPUT: Emits only ai-core events
 *   - DEV_TOOL_EVENT_STREAMING: Emits tool events with chunk buffering (64KB args, 100 pending results)
 *   - GRAPH_FINALIZATION_ONCE: Exactly one done event per run
 * Side-effects: none
 * Links: LANGGRAPH_SERVER.md (MVP section)
 * @internal
 */

import type { GraphId } from "@cogni/ai-core";
import type {
  AiEvent,
  AssistantFinalEvent,
  DoneEvent,
  TextDeltaEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
  UsageFact,
  UsageReportEvent,
} from "@cogni/node-core";
import { makeLogger } from "@/shared/observability";

const log = makeLogger({ component: "langgraph-server-stream-translator" });

// Buffer caps to prevent memory exhaustion
const MAX_ARGS_BUFFER_BYTES = 65536; // 64KB per tool call
const MAX_PENDING_RESULTS = 100;

/**
 * SDK stream chunk shape.
 * Per SDK_CHUNK_SHAPE: uses event + data, not type.
 */
export interface SdkStreamChunk {
  readonly event: string;
  readonly data: unknown;
}

/**
 * Run context for usage reporting.
 */
export interface StreamRunContext {
  readonly runId: string;
  readonly attempt: number;
  readonly graphId: GraphId;
}

/**
 * LangGraph ToolCall (complete).
 */
interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/**
 * LangGraph ToolCallChunk (streaming, partial).
 * Per LangChain SDK: chunks merge by index, string fields concatenate.
 */
interface ToolCallChunk {
  readonly id?: string;
  readonly name?: string;
  readonly args?: string; // Partial JSON string
  readonly index?: number;
}

/**
 * Accumulator for streaming tool_call_chunks.
 * Keyed by `${messageId}:${index}` to isolate per-message.
 */
interface ToolCallAccumulator {
  id?: string;
  name?: string;
  argsBuffer: string;
}

/**
 * Buffered tool result for late visibility case.
 */
interface PendingToolResult {
  readonly toolCallId: string;
  readonly result: Record<string, unknown>;
  readonly isError?: boolean;
}

/**
 * Try to parse JSON string.
 * @returns { ok: true, value } on success, { ok: false } on failure
 */
function tryParseJson(
  str: string
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch {
    return { ok: false };
  }
}

/**
 * Wrap non-object values in { value: x } for ToolCallResultEvent.result type safety.
 * The event type expects Record<string, unknown>.
 */
function wrapAsRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

/**
 * Extract message chunk from SDK data.
 * Handles messages-tuple stream mode: data is [messageChunk, metadata].
 */
function extractMessageChunk(
  data: unknown
): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object") return undefined;

  const obj = data as Record<string, unknown>;
  // messages-tuple mode: data is array or array-like with keys "0", "1"
  const messageChunk = Array.isArray(data) ? data[0] : obj["0"];

  if (messageChunk && typeof messageChunk === "object") {
    return messageChunk as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Build usage report event.
 * Per MVP Known Limitations: no usageUnitId or costUsd available.
 */
function buildUsageReport(ctx: StreamRunContext): UsageReportEvent {
  const fact: UsageFact = {
    runId: ctx.runId,
    attempt: ctx.attempt,
    source: "litellm",
    executorType: "langgraph_server",
    graphId: ctx.graphId,
  };
  return { type: "usage_report", fact };
}

/**
 * Translate LangGraph SDK stream to AiEvents.
 *
 * Per SDK_CHUNK_SHAPE: SDK uses chunk.event + chunk.data.
 * Per AI_CORE_IS_CANONICAL_OUTPUT: emits only ai-core events.
 * Per DEV_TOOL_EVENT_STREAMING: emits tool_call_start/tool_call_result with chunk buffering.
 *
 * Stream sequence: (text_delta | tool_call_start | tool_call_result)* → assistant_final → usage_report → done
 *
 * @param sdkStream - Async iterable from SDK runs.stream()
 * @param ctx - Run context for usage reporting
 * @yields AiEvent stream
 */
export async function* translateDevServerStream(
  sdkStream: AsyncIterable<SdkStreamChunk>,
  ctx: StreamRunContext
): AsyncIterable<AiEvent> {
  let accumulatedContent = "";

  // Tool call state
  const toolCallAccumulators = new Map<string, ToolCallAccumulator>();
  const emittedToolCalls = new Set<string>();
  const pendingToolResults = new Map<string, PendingToolResult>();

  /**
   * Emit tool_call_start if not already emitted, flush pending result if exists.
   */
  function* emitToolCallStart(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Generator<AiEvent> {
    if (emittedToolCalls.has(toolCallId)) return;

    emittedToolCalls.add(toolCallId);
    const startEvent: ToolCallStartEvent = {
      type: "tool_call_start",
      toolCallId,
      toolName,
      args,
    };
    yield startEvent;

    // Flush pending result if it arrived before start
    const pending = pendingToolResults.get(toolCallId);
    if (pending) {
      pendingToolResults.delete(toolCallId);
      const resultEvent: ToolCallResultEvent = {
        type: "tool_call_result",
        toolCallId: pending.toolCallId,
        result: pending.result,
        ...(pending.isError !== undefined && { isError: pending.isError }),
      };
      yield resultEvent;
    }
  }

  /**
   * Process complete tool_calls from AI message.
   */
  function* processToolCalls(toolCalls: ToolCall[]): Generator<AiEvent> {
    for (const tc of toolCalls) {
      yield* emitToolCallStart(tc.id, tc.name, tc.args);
    }
  }

  /**
   * Accumulate tool_call_chunk and emit when complete.
   */
  function* processToolCallChunk(
    messageId: string | undefined,
    chunk: ToolCallChunk
  ): Generator<AiEvent> {
    // Require message.id for proper keying (footgun fix)
    if (!messageId) {
      log.warn(
        { index: chunk.index },
        "Skipping tool_call_chunk without message.id"
      );
      return;
    }

    const key = `${messageId}:${chunk.index ?? 0}`;
    let acc = toolCallAccumulators.get(key);

    if (!acc) {
      acc = { argsBuffer: "" };
      toolCallAccumulators.set(key, acc);
    }

    // Merge chunk fields (LangChain behavior: concatenate strings)
    if (chunk.id) acc.id = chunk.id;
    if (chunk.name) acc.name = chunk.name;
    if (chunk.args) {
      // Check buffer cap
      if (acc.argsBuffer.length + chunk.args.length > MAX_ARGS_BUFFER_BYTES) {
        log.warn(
          {
            key,
            currentSize: acc.argsBuffer.length,
            chunkSize: chunk.args.length,
          },
          "Tool call args buffer exceeded cap, truncating"
        );
        acc.argsBuffer = acc.argsBuffer.slice(
          0,
          MAX_ARGS_BUFFER_BYTES - chunk.args.length
        );
      }
      acc.argsBuffer += chunk.args;
    }

    // Emit when complete: id + name + parseable args
    if (acc.id && acc.name) {
      const parsed = tryParseJson(acc.argsBuffer);
      if (parsed.ok) {
        const args = wrapAsRecord(parsed.value);
        yield* emitToolCallStart(acc.id, acc.name, args);
        // Clean up accumulator after successful emit
        toolCallAccumulators.delete(key);
      }
    }
  }

  /**
   * Process AI message chunk.
   */
  function* processAiMessage(msg: Record<string, unknown>): Generator<AiEvent> {
    // 1. Text content
    if (typeof msg.content === "string" && msg.content.length > 0) {
      accumulatedContent += msg.content;
      const textEvent: TextDeltaEvent = {
        type: "text_delta",
        delta: msg.content,
      };
      yield textEvent;
    }

    // 2. Complete tool_calls (preferred path)
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      yield* processToolCalls(msg.tool_calls as ToolCall[]);
    }

    // 3. Streaming tool_call_chunks
    if (
      Array.isArray(msg.tool_call_chunks) &&
      msg.tool_call_chunks.length > 0
    ) {
      const messageId = typeof msg.id === "string" ? msg.id : undefined;
      for (const tcc of msg.tool_call_chunks as ToolCallChunk[]) {
        yield* processToolCallChunk(messageId, tcc);
      }
    }
  }

  /**
   * Process Tool message chunk.
   */
  function* processToolMessage(
    msg: Record<string, unknown>
  ): Generator<AiEvent> {
    const toolCallId = msg.tool_call_id;
    if (typeof toolCallId !== "string") {
      log.warn({ msg }, "Tool message missing tool_call_id");
      return;
    }

    // Parse content with fallback
    const content = typeof msg.content === "string" ? msg.content : "";
    const parsed = tryParseJson(content);
    const result = parsed.ok ? wrapAsRecord(parsed.value) : { raw: content };

    if (emittedToolCalls.has(toolCallId)) {
      // Normal case: start already emitted
      const resultEvent: ToolCallResultEvent = {
        type: "tool_call_result",
        toolCallId,
        result,
      };
      yield resultEvent;
    } else {
      // Late visibility: buffer result
      if (pendingToolResults.size >= MAX_PENDING_RESULTS) {
        log.warn(
          { toolCallId, pendingCount: pendingToolResults.size },
          "Pending tool results buffer full, dropping oldest"
        );
        // Drop oldest entry
        const firstKey = pendingToolResults.keys().next().value;
        if (firstKey) pendingToolResults.delete(firstKey);
      }
      pendingToolResults.set(toolCallId, { toolCallId, result });
    }
  }

  // Main stream processing loop
  for await (const chunk of sdkStream) {
    switch (chunk.event) {
      case "messages": {
        const msg = extractMessageChunk(chunk.data);
        if (!msg) break;

        if (msg.type === "ai") {
          yield* processAiMessage(msg);
        } else if (msg.type === "tool") {
          yield* processToolMessage(msg);
        } else {
          log.debug({ type: msg.type }, "Ignoring message type");
        }
        break;
      }

      case "error": {
        log.error({ data: chunk.data }, "Stream error event");
        yield { type: "error", error: "internal" } as AiEvent;
        break;
      }

      case "metadata":
        // Ignore in MVP (no reconnection support)
        break;

      default:
        log.warn({ event: chunk.event }, "Unknown stream event type");
        break;
    }
  }

  // Flush orphan pending results with warning
  for (const pending of pendingToolResults.values()) {
    log.warn(
      { toolCallId: pending.toolCallId },
      "Orphan tool result (no matching start)"
    );
    const resultEvent: ToolCallResultEvent = {
      type: "tool_call_result",
      toolCallId: pending.toolCallId,
      result: pending.result,
    };
    yield resultEvent;
  }

  // Finalization
  const finalEvent: AssistantFinalEvent = {
    type: "assistant_final",
    content: accumulatedContent,
  };
  yield finalEvent;

  yield buildUsageReport(ctx);

  const doneEvent: DoneEvent = { type: "done" };
  yield doneEvent;
}
