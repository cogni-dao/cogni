// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/message-serialization.test`
 * Purpose: Tests LiteLLM adapter message serialization for tool use.
 * Scope: Unit tests for message→LiteLLM format conversion. Does NOT test HTTP or streaming.
 * Invariants:
 *   - tool_calls serialized on assistant messages
 *   - tool_call_id serialized on tool messages
 *   - Message ordering: assistant(tool_calls) before tool(tool_call_id)
 *   - Tool message count equals tool_calls count
 * Side-effects: none
 * Notes: Tests the fix for 400 Bad Request on agentic loop second call.
 * Links: litellm.adapter.ts, TOOL_USE_SPEC.md
 * @public
 */

import type { Message } from "@cogni/node-core";
import {
  createAssistantMessageWithToolCalls,
  createMessageToolCall,
  createToolResultMessage,
  createUserMessage,
  TEST_TOOL_CALL_ID,
  TEST_TOOL_NAME,
} from "@tests/_fakes";
import { describe, expect, it } from "vitest";

/**
 * Message serialization logic extracted for testing.
 * This mirrors the transformation in litellm.adapter.ts lines 139-160 and 330-351.
 *
 * We test this logic directly rather than through HTTP to keep tests fast and focused.
 */
function serializeMessagesForLiteLLM(
  messages: Message[]
): Record<string, unknown>[] {
  return messages.map((msg) => {
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
}

describe("adapters/server/ai/litellm message serialization", () => {
  describe("tool_calls serialization", () => {
    it("serializes tool_calls on assistant messages", () => {
      // Arrange
      const toolCall = createMessageToolCall({
        id: TEST_TOOL_CALL_ID,
        name: TEST_TOOL_NAME,
        arguments: { value: "test" },
      });
      const message = createAssistantMessageWithToolCalls([toolCall]);

      // Act
      const serialized = serializeMessagesForLiteLLM([message]);

      // Assert
      expect(serialized).toHaveLength(1);
      expect(serialized[0].tool_calls).toBeDefined();
      expect(serialized[0].tool_calls).toHaveLength(1);

      const tc = (serialized[0].tool_calls as unknown[])[0] as Record<
        string,
        unknown
      >;
      expect(tc.id).toBe(TEST_TOOL_CALL_ID);
      expect(tc.type).toBe("function");
      expect((tc.function as Record<string, unknown>).name).toBe(
        TEST_TOOL_NAME
      );
    });

    it("serializes tool_call_id on tool messages", () => {
      // Arrange
      const message = createToolResultMessage(TEST_TOOL_CALL_ID, {
        result: "done",
      });

      // Act
      const serialized = serializeMessagesForLiteLLM([message]);

      // Assert
      expect(serialized).toHaveLength(1);
      expect(serialized[0].role).toBe("tool");
      expect(serialized[0].tool_call_id).toBe(TEST_TOOL_CALL_ID);
      expect(serialized[0].content).toBe('{"result":"done"}');
    });

    it("omits tool fields when not present (regular messages)", () => {
      // Arrange
      const userMsg = createUserMessage("Hello");
      const assistantMsg: Message = { role: "assistant", content: "Hi there" };

      // Act
      const serialized = serializeMessagesForLiteLLM([userMsg, assistantMsg]);

      // Assert
      expect(serialized[0]).not.toHaveProperty("tool_calls");
      expect(serialized[0]).not.toHaveProperty("tool_call_id");
      expect(serialized[1]).not.toHaveProperty("tool_calls");
      expect(serialized[1]).not.toHaveProperty("tool_call_id");
    });
  });

  describe("message ordering contract", () => {
    it("assistant(tool_calls) appears before tool(tool_call_id) messages", () => {
      // Arrange - Simulate agentic loop message sequence
      const toolCall1 = createMessageToolCall({
        id: "call_1",
        name: "tool_a",
        arguments: { x: 1 },
      });
      const toolCall2 = createMessageToolCall({
        id: "call_2",
        name: "tool_b",
        arguments: { y: 2 },
      });

      const messages: Message[] = [
        createUserMessage("Do something"),
        createAssistantMessageWithToolCalls([toolCall1, toolCall2]),
        createToolResultMessage("call_1", { result: "a" }),
        createToolResultMessage("call_2", { result: "b" }),
      ];

      // Act
      const serialized = serializeMessagesForLiteLLM(messages);

      // Assert - Find indices
      const assistantWithToolsIdx = serialized.findIndex(
        (m) => m.role === "assistant" && m.tool_calls
      );
      const toolMessageIndices = serialized
        .map((m, i) => (m.role === "tool" ? i : -1))
        .filter((i) => i !== -1);

      // Assistant with tool_calls must come before all tool messages
      expect(assistantWithToolsIdx).toBeGreaterThan(-1);
      for (const toolIdx of toolMessageIndices) {
        expect(assistantWithToolsIdx).toBeLessThan(toolIdx);
      }
    });

    it("tool message count equals tool_calls count", () => {
      // Arrange
      const toolCall1 = createMessageToolCall({ id: "call_1", name: "tool_a" });
      const toolCall2 = createMessageToolCall({ id: "call_2", name: "tool_b" });
      const toolCall3 = createMessageToolCall({ id: "call_3", name: "tool_c" });

      const assistantMsg = createAssistantMessageWithToolCalls([
        toolCall1,
        toolCall2,
        toolCall3,
      ]);

      const messages: Message[] = [
        createUserMessage("Do things"),
        assistantMsg,
        createToolResultMessage("call_1", { r: 1 }),
        createToolResultMessage("call_2", { r: 2 }),
        createToolResultMessage("call_3", { r: 3 }),
      ];

      // Act
      const serialized = serializeMessagesForLiteLLM(messages);

      // Assert
      const assistantWithTools = serialized.find(
        (m) => m.role === "assistant" && m.tool_calls
      );
      const toolMessages = serialized.filter((m) => m.role === "tool");
      const toolCallsArray = assistantWithTools?.tool_calls as unknown[];

      expect(toolCallsArray).toBeDefined();
      expect(toolMessages.length).toBe(toolCallsArray.length);
    });

    it("each tool message references a valid tool_call_id from assistant", () => {
      // Arrange
      const toolCall1 = createMessageToolCall({
        id: "call_abc",
        name: "tool_x",
      });
      const toolCall2 = createMessageToolCall({
        id: "call_def",
        name: "tool_y",
      });

      const messages: Message[] = [
        createUserMessage("Execute"),
        createAssistantMessageWithToolCalls([toolCall1, toolCall2]),
        createToolResultMessage("call_abc", { done: true }),
        createToolResultMessage("call_def", { done: true }),
      ];

      // Act
      const serialized = serializeMessagesForLiteLLM(messages);

      // Assert - Extract tool_call IDs from assistant message
      const assistantWithTools = serialized.find(
        (m) => m.role === "assistant" && m.tool_calls
      );
      const toolCallIds = (
        assistantWithTools?.tool_calls as { id: string }[]
      ).map((tc) => tc.id);

      // Each tool message's tool_call_id should be in the set
      const toolMessages = serialized.filter((m) => m.role === "tool");
      for (const toolMsg of toolMessages) {
        expect(toolCallIds).toContain(toolMsg.tool_call_id);
      }
    });
  });

  describe("multi-turn tool use", () => {
    it("handles multiple tool use rounds in conversation", () => {
      // Arrange - Two rounds of tool use
      const messages: Message[] = [
        // Round 1
        createUserMessage("What time is it?"),
        createAssistantMessageWithToolCalls([
          createMessageToolCall({ id: "call_r1", name: "get_time" }),
        ]),
        createToolResultMessage("call_r1", { time: "12:00" }),
        // Assistant responds after round 1
        { role: "assistant", content: "It is 12:00" },
        // Round 2
        createUserMessage("And the date?"),
        createAssistantMessageWithToolCalls([
          createMessageToolCall({ id: "call_r2", name: "get_date" }),
        ]),
        createToolResultMessage("call_r2", { date: "2025-01-01" }),
      ];

      // Act
      const serialized = serializeMessagesForLiteLLM(messages);

      // Assert - Verify structure is preserved
      expect(serialized).toHaveLength(7);

      // First tool round
      expect(
        (serialized[1] as { tool_calls?: unknown[] }).tool_calls
      ).toHaveLength(1);
      expect(serialized[2].tool_call_id).toBe("call_r1");

      // Plain assistant response
      expect(serialized[3].role).toBe("assistant");
      expect(serialized[3]).not.toHaveProperty("tool_calls");

      // Second tool round
      expect(
        (serialized[5] as { tool_calls?: unknown[] }).tool_calls
      ).toHaveLength(1);
      expect(serialized[6].tool_call_id).toBe("call_r2");
    });
  });
});
