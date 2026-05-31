// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/chat-tool-replay.stack`
 * Purpose: Verify chat route handles multi-turn tool replay (role:'tool' messages) correctly.
 * Scope: Tests route → toMessageDtos → completionStream pipeline for tool message handling. Does not test actual LLM calls or billing.
 * Invariants:
 *   - role:'tool' messages with toolCallId reach facade as MessageDto
 *   - Tool events (tool_call_start, tool_call_result) appear in Data Stream Protocol output
 *   - Second user message after tool call doesn't cause 400/500
 * Side-effects: none
 * Notes: Uses vi.doMock + vi.resetModules to mock dynamic imports. Per TOOL_USE_SPEC.md P0.
 * Links: src/app/api/v1/ai/chat/route.ts, docs/spec/tool-use.md
 * @public
 */

import { randomUUID } from "node:crypto";
import { TEST_GRAPH_NAME } from "@tests/_fakes";
import {
  DataStreamChunkType,
  isErrorEvent,
  isFinishMessageEvent,
  isTextDeltaEvent,
} from "@tests/helpers/data-stream";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Test constants - fixed values for deterministic assertions
const TEST_TOOL_CALL_ID = "tc_replay_001";
const TEST_TOOL_NAME = "get_current_time";
const TEST_MODEL = "gpt-4o-mini";
const TEST_REQUEST_ID = "req_test_tool_replay";
const TEST_THREAD_ID = "thread_test_001";
const TEST_CLIENT_REQUEST_ID = "client_req_001";
const TEST_TIMESTAMP = "2026-01-04T12:00:00.000Z";

// Track completionStream calls for assertions
let completionStreamCalls: Array<{
  messages: Array<{
    role: string;
    content: string;
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    toolCallId?: string;
  }>;
  modelRef: { providerKey: string; modelId: string };
}> = [];

// Mock factory for completionStream
function createCompletionStreamMock() {
  return vi.fn().mockImplementation((input) => {
    // Record call for assertion
    completionStreamCalls.push({
      messages: input.messages,
      modelRef: input.modelRef,
    });

    // Create fake event stream with tool events
    // Order: tool_call_start FIRST (so controller exists), then text, then result
    async function* fakeStream() {
      yield {
        type: "tool_call_start" as const,
        toolCallId: TEST_TOOL_CALL_ID,
        toolName: TEST_TOOL_NAME,
        args: { timezone: "UTC" },
      };
      yield { type: "text_delta" as const, delta: "The current time is " };
      yield {
        type: "tool_call_result" as const,
        toolCallId: TEST_TOOL_CALL_ID,
        result: { time: "2026-01-04T12:00:00Z" },
      };
      yield { type: "text_delta" as const, delta: "12:00 PM UTC." };
      yield { type: "done" as const };
    }

    const final = Promise.resolve({
      ok: true as const,
      requestId: TEST_REQUEST_ID,
      usage: { promptTokens: 100, completionTokens: 50 },
      finishReason: "stop",
    });

    return { stream: fakeStream(), final };
  });
}

// Skipped: P0 thread persistence ignores client-supplied message history.
// The server now loads authoritative history from ai_threads DB, so client
// replay and client-side tool validation are no longer exercised.
// TODO(P1): Re-enable once client sends stateKey + single message instead of full history.
describe.skip("Chat Tool Replay", () => {
  let completionStreamMock: ReturnType<typeof createCompletionStreamMock>;

  beforeEach(async () => {
    completionStreamCalls = [];
    completionStreamMock = createCompletionStreamMock();

    // Reset module cache to ensure clean slate
    vi.resetModules();

    // Mock session BEFORE importing route
    vi.doMock("@/app/_lib/auth/session", () => ({
      getSessionUser: vi.fn().mockResolvedValue({
        id: "user_test_001",
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    }));

    // Mock model catalog BEFORE importing route
    vi.doMock("@/shared/ai/model-catalog.server", () => ({
      isModelAllowed: vi.fn().mockResolvedValue(true),
      getDefaults: vi.fn().mockResolvedValue({
        defaultPreferredModelId: TEST_MODEL,
        defaultFreeModelId: TEST_MODEL,
      }),
    }));

    // Mock completion facade BEFORE importing route
    vi.doMock("@/app/_facades/ai/completion.server", () => ({
      completionStream: completionStreamMock,
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("supports second turn after tool call (replay history)", async () => {
    // Import route AFTER mocks are set up
    const { POST: chatPOST } = await import("@/app/api/v1/ai/chat/route");

    // Replay payload: user → assistant(tool-call) → tool(tool-result) → user
    const replayPayload = {
      stateKey: TEST_THREAD_ID,
      clientRequestId: TEST_CLIENT_REQUEST_ID,
      modelRef: { providerKey: "platform", modelId: TEST_MODEL },
      graphName: TEST_GRAPH_NAME,
      stream: true,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          createdAt: TEST_TIMESTAMP,
          content: [{ type: "text", text: "What time is it?" }],
        },
        {
          id: randomUUID(),
          role: "assistant",
          createdAt: TEST_TIMESTAMP,
          content: [
            {
              type: "tool-call",
              toolCallId: TEST_TOOL_CALL_ID,
              toolName: TEST_TOOL_NAME,
              args: { timezone: "UTC" },
            },
          ],
        },
        {
          id: randomUUID(),
          role: "tool",
          createdAt: TEST_TIMESTAMP,
          content: [
            {
              type: "tool-result",
              toolCallId: TEST_TOOL_CALL_ID,
              result: { time: "2026-01-04T12:00:00Z" },
            },
          ],
        },
        {
          id: randomUUID(),
          role: "user",
          createdAt: TEST_TIMESTAMP,
          content: [{ type: "text", text: "Thanks! What day is it?" }],
        },
      ],
    };

    // Act - Send request with replay history
    const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(replayPayload),
    });

    const res = await chatPOST(req);

    // Assert - HTTP 200 (no validation error)
    expect(res.status).toBe(200);

    // Assert - completionStream was called (proves mock applied)
    expect(completionStreamMock).toHaveBeenCalledTimes(1);

    // Collect all stream events - read until EOF, not just until FinishMessage
    const events: Array<{ type: string; value: unknown }> = [];
    const rawLines: string[] = [];

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body reader");

    const decoder = new TextDecoder();
    let buf = "";
    let streamEndedCleanly = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          streamEndedCleanly = true;
          break;
        }
        buf += decoder.decode(value, { stream: true });

        let idx = buf.indexOf("\n");
        while (idx !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim()) {
            rawLines.push(line);
            const colonIdx = line.indexOf(":");
            if (colonIdx !== -1) {
              const type = line.slice(0, colonIdx);
              try {
                const parsedValue = JSON.parse(line.slice(colonIdx + 1));
                events.push({ type, value: parsedValue });
              } catch {
                /* skip parse errors */
              }
            }
          }
          idx = buf.indexOf("\n");
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Assert stream ended cleanly
    expect(streamEndedCleanly).toBe(true);

    // Assert - No error chunks emitted
    const errorEvents = events.filter((e) => isErrorEvent(e));
    expect(errorEvents).toHaveLength(0);

    // Assert - TextDelta chunks appear
    const textDeltas = events.filter((e) => isTextDeltaEvent(e));
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);

    // Assert - StartToolCall chunk with correct toolCallId and toolName
    const startToolCalls = events.filter(
      (e) => e.type === DataStreamChunkType.StartToolCall
    );
    expect(startToolCalls.length).toBeGreaterThanOrEqual(1);
    const startToolCall = startToolCalls[0]?.value as {
      toolCallId?: string;
      toolName?: string;
    };
    expect(startToolCall?.toolCallId).toBe(TEST_TOOL_CALL_ID);
    expect(startToolCall?.toolName).toBe(TEST_TOOL_NAME);

    // Assert - ToolCallResult chunk with correct toolCallId
    // This validates that route properly awaits setResponse() and flushes before close
    const toolResults = events.filter(
      (e) => e.type === DataStreamChunkType.ToolCallResult
    );
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    const toolResult = toolResults[0]?.value as { toolCallId?: string };
    expect(toolResult?.toolCallId).toBe(TEST_TOOL_CALL_ID);

    // Assert - Exactly one FinishMessage chunk
    const finishEvents = events.filter((e) => isFinishMessageEvent(e));
    expect(finishEvents).toHaveLength(1);

    // Note: Ideally ToolCallResult ("a:") should precede FinishMessage ("d:"),
    // but assistant-stream's async merger doesn't guarantee ordering.
    // TODO(assistant-stream): Upstream fix needed for reliable chunk ordering.
    // For now, we verify both chunks exist (proves close() was called).

    // Assert - Facade received correct message DTOs
    expect(completionStreamCalls).toHaveLength(1);
    const facadeCall = completionStreamCalls[0];

    // Check assistant message has toolCalls with correct id
    const assistantDto = facadeCall?.messages.find(
      (m) => m.role === "assistant"
    );
    expect(assistantDto).toBeDefined();
    expect(assistantDto?.toolCalls).toBeDefined();
    expect(assistantDto?.toolCalls).toHaveLength(1);
    expect(assistantDto?.toolCalls?.[0]?.id).toBe(TEST_TOOL_CALL_ID);

    // Check tool message has role:'tool' and toolCallId
    const toolDto = facadeCall?.messages.find((m) => m.role === "tool");
    expect(toolDto).toBeDefined();
    expect(toolDto?.role).toBe("tool");
    expect(toolDto?.toolCallId).toBe(TEST_TOOL_CALL_ID);
  });

  it("rejects tool-result with unknown toolCallId", async () => {
    const { POST: chatPOST } = await import("@/app/api/v1/ai/chat/route");

    // Payload with tool-result referencing unknown toolCallId
    const invalidPayload = {
      stateKey: TEST_THREAD_ID,
      clientRequestId: TEST_CLIENT_REQUEST_ID,
      modelRef: { providerKey: "platform", modelId: TEST_MODEL },
      graphName: TEST_GRAPH_NAME,
      stream: true,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          createdAt: TEST_TIMESTAMP,
          content: [{ type: "text", text: "Hello" }],
        },
        {
          id: randomUUID(),
          role: "tool",
          createdAt: TEST_TIMESTAMP,
          content: [
            {
              type: "tool-result",
              toolCallId: "unknown_tc_id",
              result: { data: "test" },
            },
          ],
        },
      ],
    };

    const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(invalidPayload),
    });

    const res = await chatPOST(req);

    // Assert - 400 validation error
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details).toContain("unknown toolCallId");
  });

  it("rejects duplicate tool-result for same toolCallId", async () => {
    const { POST: chatPOST } = await import("@/app/api/v1/ai/chat/route");

    // Payload with duplicate tool-results
    const duplicatePayload = {
      stateKey: TEST_THREAD_ID,
      clientRequestId: TEST_CLIENT_REQUEST_ID,
      modelRef: { providerKey: "platform", modelId: TEST_MODEL },
      graphName: TEST_GRAPH_NAME,
      stream: true,
      messages: [
        {
          id: randomUUID(),
          role: "user",
          createdAt: TEST_TIMESTAMP,
          content: [{ type: "text", text: "Hello" }],
        },
        {
          id: randomUUID(),
          role: "assistant",
          createdAt: TEST_TIMESTAMP,
          content: [
            {
              type: "tool-call",
              toolCallId: TEST_TOOL_CALL_ID,
              toolName: TEST_TOOL_NAME,
              args: {},
            },
          ],
        },
        {
          id: randomUUID(),
          role: "tool",
          createdAt: TEST_TIMESTAMP,
          content: [
            {
              type: "tool-result",
              toolCallId: TEST_TOOL_CALL_ID,
              result: { first: true },
            },
          ],
        },
        {
          id: randomUUID(),
          role: "tool",
          createdAt: TEST_TIMESTAMP,
          content: [
            {
              type: "tool-result",
              toolCallId: TEST_TOOL_CALL_ID,
              result: { duplicate: true },
            },
          ],
        },
      ],
    };

    const req = new NextRequest("http://localhost:3000/api/v1/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(duplicatePayload),
    });

    const res = await chatPOST(req);

    // Assert - 400 validation error
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details).toContain("duplicate");
  });
});
