// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/helpers/data-stream`
 * Purpose: AI SDK Data Stream Protocol (SSE) parsing utilities for testing.
 * Scope: Provides utilities to parse SSE-formatted UIMessageChunk events in tests. Does not contain test assertions.
 * Invariants: Yields parsed events incrementally as they arrive; handles SSE `data: {json}` format
 * Side-effects: IO (reads from ReadableStream)
 * Notes: P1 wire format — parses `data: {json}\n\n` SSE events from createUIMessageStreamResponse.
 * Links: tests/stack/ai/chat-streaming.stack.test.ts, AI SDK streaming
 * @public
 */

/**
 * Parsed SSE event structure (UIMessageChunk from AI SDK)
 */
export interface SseEvent {
  /** The chunk type (e.g., "text-delta", "text-start", "finish", "error") */
  type: string;
  /** The full parsed JSON payload */
  data: Record<string, unknown>;
}

/**
 * Asynchronously reads and parses AI SDK Data Stream Protocol (SSE) events from a Response body stream.
 *
 * SSE format from createUIMessageStreamResponse:
 * - Each event is: `data: {json}\n\n`
 * - `data: [DONE]\n\n` signals end of stream
 *
 * @param res - Response object with a readable body stream
 * @yields {SseEvent} Parsed events as they arrive
 * @throws {Error} If response body is not readable or parsing fails
 *
 * @example
 * ```ts
 * const response = await fetch('/api/chat');
 * for await (const event of readSseEvents(response)) {
 *   if (isTextDeltaEvent(event)) {
 *     console.log('Text:', event.data.delta);
 *   }
 * }
 * ```
 */
export async function* readSseEvents(res: Response): AsyncIterable<SseEvent> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body reader");

  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      // SSE events are delimited by double newlines
      let idx = buf.indexOf("\n\n");
      while (idx !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        // Parse SSE data lines from block
        for (const line of block.split("\n")) {
          if (!line.startsWith("data: ")) continue;

          const payload = line.slice(6); // Remove "data: " prefix

          // [DONE] signals end of stream
          if (payload === "[DONE]") return;

          let data: Record<string, unknown>;
          try {
            data = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            throw new Error(`Invalid JSON in SSE data: ${payload}`);
          }

          if (typeof data.type === "string") {
            yield { type: data.type, data };
          }
        }

        idx = buf.indexOf("\n\n");
      }
    }

    // Process any remaining content
    if (buf.trim().length > 0) {
      for (const line of buf.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") return;
        try {
          const data = JSON.parse(payload) as Record<string, unknown>;
          if (typeof data.type === "string") {
            yield { type: data.type, data };
          }
        } catch {
          // Ignore incomplete final chunk
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Type guard for text-delta events
 */
export function isTextDeltaEvent(event: SseEvent): event is SseEvent & {
  data: { type: "text-delta"; delta: string; id: string };
} {
  return event.type === "text-delta";
}

/**
 * Type guard for text-start events
 */
export function isTextStartEvent(
  event: SseEvent
): event is SseEvent & { data: { type: "text-start"; id: string } } {
  return event.type === "text-start";
}

/**
 * Type guard for finish events
 */
export function isFinishEvent(event: SseEvent): boolean {
  return event.type === "finish";
}

/**
 * Type guard for error events
 */
export function isErrorEvent(
  event: SseEvent
): event is SseEvent & { data: { type: "error"; errorText: string } } {
  return event.type === "error";
}

// ─── Legacy aliases for backwards compatibility with existing test imports ────

/** @deprecated Use readSseEvents */
export const readDataStreamEvents = readSseEvents;
/** @deprecated Use isFinishEvent */
export const isFinishMessageEvent = isFinishEvent;

/**
 * @deprecated Data Stream chunk types no longer apply to SSE format.
 * Kept for stack test compilation — values are meaningless in the new format.
 */
export const DataStreamChunkType = {
  TextDelta: "text-delta",
  Data: "data",
  Error: "error",
  Annotation: "annotation",
  ToolCall: "tool-call",
  ToolCallResult: "tool-result",
  StartToolCall: "tool-input-start",
  ToolCallArgsTextDelta: "tool-input-delta",
  FinishMessage: "finish",
  FinishStep: "finish-step",
  StartStep: "start-step",
  ReasoningDelta: "reasoning-delta",
  Source: "source",
} as const;
