// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/langgraph/dev/stream-translator.test`
 * Purpose: Unit tests for LangGraph SDK stream-to-AiEvent translation.
 * Scope: Tests tool_calls, tool_call_chunks buffering, late visibility, and result wrapping. Does NOT test real SDK streams.
 * Invariants: none (test file)
 * Side-effects: none
 * Links: stream-translator.ts
 * @internal
 */

import type { AiEvent } from "@cogni/node-core";
import { describe, expect, it } from "vitest";
import { runInScope } from "@/adapters/server/ai/execution-scope";
import {
  type SdkStreamChunk,
  type StreamRunContext,
  translateDevServerStream,
} from "@/adapters/server/ai/langgraph/dev/stream-translator";

const TEST_SCOPE = {
  billing: {
    billingAccountId: "account-123",
    virtualKeyId: "vkey-123",
  },
  usageSource: "litellm" as const,
};

/**
 * Helper to create mock stream run context.
 */
function mockContext(): StreamRunContext {
  return {
    runId: "run-123",
    attempt: 1,
  };
}

/**
 * Helper to create async iterable from array of chunks.
 */
async function* mockStream(
  chunks: SdkStreamChunk[]
): AsyncIterable<SdkStreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/**
 * Helper to collect all events from async iterable.
 */
async function collectEvents(
  stream: AsyncIterable<AiEvent>
): Promise<AiEvent[]> {
  return runInScope(TEST_SCOPE, async () => {
    const events: AiEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    return events;
  });
}

/**
 * Helper to create a messages-tuple chunk (SDK format).
 */
function messagesChunk(messageChunk: Record<string, unknown>): SdkStreamChunk {
  return {
    event: "messages",
    data: [messageChunk, {}], // [messageChunk, metadata]
  };
}

describe("translateDevServerStream", () => {
  describe("complete tool_calls path", () => {
    it("emits tool_call_start once and tool_call_result when ToolMessage arrives", async () => {
      const chunks: SdkStreamChunk[] = [
        // AI message with complete tool_calls
        messagesChunk({
          type: "ai",
          id: "msg-1",
          content: "Let me check the time.",
          tool_calls: [
            { id: "tc-1", name: "get_current_time", args: { timezone: "UTC" } },
          ],
        }),
        // Tool result message
        messagesChunk({
          type: "tool",
          id: "tool-1",
          tool_call_id: "tc-1",
          content: '{"time":"2024-01-19T12:00:00Z"}',
        }),
        // AI final response
        messagesChunk({
          type: "ai",
          id: "msg-2",
          content: "The time is 12:00 UTC.",
        }),
      ];

      const events = await collectEvents(
        translateDevServerStream(mockStream(chunks), mockContext())
      );

      // Find tool events
      const toolStartEvents = events.filter(
        (e) => e.type === "tool_call_start"
      );
      const toolResultEvents = events.filter(
        (e) => e.type === "tool_call_result"
      );

      // Should emit exactly one start
      expect(toolStartEvents).toHaveLength(1);
      expect(toolStartEvents[0]).toMatchObject({
        type: "tool_call_start",
        toolCallId: "tc-1",
        toolName: "get_current_time",
        args: { timezone: "UTC" },
      });

      // Should emit exactly one result
      expect(toolResultEvents).toHaveLength(1);
      expect(toolResultEvents[0]).toMatchObject({
        type: "tool_call_result",
        toolCallId: "tc-1",
        result: { time: "2024-01-19T12:00:00Z" },
      });

      // Start should come before result
      const startIdx = events.findIndex((e) => e.type === "tool_call_start");
      const resultIdx = events.findIndex((e) => e.type === "tool_call_result");
      expect(startIdx).toBeLessThan(resultIdx);
    });
  });

  describe("tool_call_chunks path", () => {
    it("buffers chunks and emits tool_call_start only when args become parseable", async () => {
      const chunks: SdkStreamChunk[] = [
        // First chunk: has id and name, but partial args
        messagesChunk({
          type: "ai",
          id: "msg-1",
          tool_call_chunks: [
            {
              id: "tc-1",
              name: "get_current_time",
              args: '{"timezone":',
              index: 0,
            },
          ],
        }),
        // Second chunk: completes the args JSON
        messagesChunk({
          type: "ai",
          id: "msg-1",
          tool_call_chunks: [{ args: '"UTC"}', index: 0 }],
        }),
        // Tool result
        messagesChunk({
          type: "tool",
          tool_call_id: "tc-1",
          content: '{"time":"12:00"}',
        }),
      ];

      const events = await collectEvents(
        translateDevServerStream(mockStream(chunks), mockContext())
      );

      const toolStartEvents = events.filter(
        (e) => e.type === "tool_call_start"
      );
      const toolResultEvents = events.filter(
        (e) => e.type === "tool_call_result"
      );

      // Should emit exactly one start (only after args parseable)
      expect(toolStartEvents).toHaveLength(1);
      expect(toolStartEvents[0]).toMatchObject({
        type: "tool_call_start",
        toolCallId: "tc-1",
        toolName: "get_current_time",
        args: { timezone: "UTC" }, // Objects pass through unwrapped
      });

      // Should emit result
      expect(toolResultEvents).toHaveLength(1);
    });
  });

  describe("late tool visibility", () => {
    it("buffers tool result if it arrives before tool_calls, emits after start", async () => {
      const chunks: SdkStreamChunk[] = [
        // Tool result arrives FIRST (before we've seen tool_calls)
        messagesChunk({
          type: "tool",
          tool_call_id: "tc-1",
          content: '{"result":"early"}',
        }),
        // AI message with tool_calls arrives AFTER
        messagesChunk({
          type: "ai",
          id: "msg-1",
          tool_calls: [{ id: "tc-1", name: "my_tool", args: {} }],
        }),
      ];

      const events = await collectEvents(
        translateDevServerStream(mockStream(chunks), mockContext())
      );

      const toolStartEvents = events.filter(
        (e) => e.type === "tool_call_start"
      );
      const toolResultEvents = events.filter(
        (e) => e.type === "tool_call_result"
      );

      // Both should be emitted
      expect(toolStartEvents).toHaveLength(1);
      expect(toolResultEvents).toHaveLength(1);

      // Start should come before result in final event order
      const startIdx = events.findIndex((e) => e.type === "tool_call_start");
      const resultIdx = events.findIndex((e) => e.type === "tool_call_result");
      expect(startIdx).toBeLessThan(resultIdx);

      // Result should have the buffered content
      expect(toolResultEvents[0]).toMatchObject({
        toolCallId: "tc-1",
        result: { result: "early" },
      });
    });
  });

  describe("non-object tool results", () => {
    it("wraps JSON array in { value: [...] }", async () => {
      const chunks: SdkStreamChunk[] = [
        messagesChunk({
          type: "ai",
          id: "msg-1",
          tool_calls: [{ id: "tc-1", name: "list_items", args: {} }],
        }),
        messagesChunk({
          type: "tool",
          tool_call_id: "tc-1",
          content: '["item1","item2","item3"]',
        }),
      ];

      const events = await collectEvents(
        translateDevServerStream(mockStream(chunks), mockContext())
      );

      const resultEvent = events.find((e) => e.type === "tool_call_result");
      expect(resultEvent).toMatchObject({
        type: "tool_call_result",
        toolCallId: "tc-1",
        result: { value: ["item1", "item2", "item3"] },
      });
    });

    it("wraps JSON string in { value: ... }", async () => {
      const chunks: SdkStreamChunk[] = [
        messagesChunk({
          type: "ai",
          id: "msg-1",
          tool_calls: [{ id: "tc-1", name: "get_name", args: {} }],
        }),
        messagesChunk({
          type: "tool",
          tool_call_id: "tc-1",
          content: '"hello world"',
        }),
      ];

      const events = await collectEvents(
        translateDevServerStream(mockStream(chunks), mockContext())
      );

      const resultEvent = events.find((e) => e.type === "tool_call_result");
      expect(resultEvent).toMatchObject({
        result: { value: "hello world" },
      });
    });

    it("wraps JSON null in { value: null }", async () => {
      const chunks: SdkStreamChunk[] = [
        messagesChunk({
          type: "ai",
          id: "msg-1",
          tool_calls: [{ id: "tc-1", name: "get_nothing", args: {} }],
        }),
        messagesChunk({
          type: "tool",
          tool_call_id: "tc-1",
          content: "null",
        }),
      ];

      const events = await collectEvents(
        translateDevServerStream(mockStream(chunks), mockContext())
      );

      const resultEvent = events.find((e) => e.type === "tool_call_result");
      expect(resultEvent).toMatchObject({
        result: { value: null },
      });
    });

    it("wraps non-JSON content in { raw: ... }", async () => {
      const chunks: SdkStreamChunk[] = [
        messagesChunk({
          type: "ai",
          id: "msg-1",
          tool_calls: [{ id: "tc-1", name: "get_text", args: {} }],
        }),
        messagesChunk({
          type: "tool",
          tool_call_id: "tc-1",
          content: "plain text output",
        }),
      ];

      const events = await collectEvents(
        translateDevServerStream(mockStream(chunks), mockContext())
      );

      const resultEvent = events.find((e) => e.type === "tool_call_result");
      expect(resultEvent).toMatchObject({
        result: { raw: "plain text output" },
      });
    });
  });

  it("emits a neutral usage_report event without billing identity", async () => {
    const chunks: SdkStreamChunk[] = [
      messagesChunk({
        type: "ai",
        id: "msg-1",
        content: "done",
      }),
    ];

    const events = await collectEvents(
      translateDevServerStream(mockStream(chunks), {
        ...mockContext(),
        graphId: "langgraph:poet",
      })
    );

    const usageEvent = events.find((event) => event.type === "usage_report");
    expect(usageEvent).toEqual({
      type: "usage_report",
      fact: {
        runId: "run-123",
        attempt: 1,
        source: "litellm",
        executorType: "langgraph_server",
        graphId: "langgraph:poet",
      },
    });
  });
});
