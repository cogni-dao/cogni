// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/ai/mappers-uimessage.test`
 * Purpose: Unit tests for uiMessagesToMessageDtos() mapper.
 * Scope: Tests UIMessage[] → MessageDto[] conversion. Does not test toCoreMessages().
 * Invariants: Pure function tests, no side effects
 * Side-effects: none
 * Links: src/features/ai/services/mappers.ts
 * @internal
 */

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { uiMessagesToMessageDtos } from "@/features/ai/public.server";

function makeTextPart(text: string) {
  return { type: "text" as const, text };
}

function makeToolPart(
  toolCallId: string,
  toolName: string,
  input: unknown,
  state: string,
  output?: unknown
) {
  return {
    type: "dynamic-tool" as const,
    toolCallId,
    toolName,
    input,
    state,
    ...(output !== undefined ? { output } : {}),
  };
}

function makeMessage(
  role: "user" | "assistant",
  parts: UIMessage["parts"]
): UIMessage {
  return { id: "msg-1", role, parts };
}

describe("uiMessagesToMessageDtos", () => {
  it("maps user text message", () => {
    const msgs: UIMessage[] = [makeMessage("user", [makeTextPart("hello")])];
    const dtos = uiMessagesToMessageDtos(msgs);
    expect(dtos).toEqual([{ role: "user", content: "hello" }]);
  });

  it("maps assistant text message", () => {
    const msgs: UIMessage[] = [
      makeMessage("assistant", [makeTextPart("hi there")]),
    ];
    const dtos = uiMessagesToMessageDtos(msgs);
    expect(dtos).toEqual([{ role: "assistant", content: "hi there" }]);
  });

  it("maps assistant with tool call + tool result", () => {
    const msgs: UIMessage[] = [
      makeMessage("assistant", [
        makeTextPart("Let me check"),
        makeToolPart(
          "tc-1",
          "web_search",
          { query: "test" },
          "output-available",
          {
            results: ["a"],
          }
        ),
      ]),
    ];
    const dtos = uiMessagesToMessageDtos(msgs);
    expect(dtos).toHaveLength(2);
    expect(dtos[0]).toEqual({
      role: "assistant",
      content: "Let me check",
      toolCalls: [
        { id: "tc-1", name: "web_search", arguments: '{"query":"test"}' },
      ],
    });
    expect(dtos[1]).toEqual({
      role: "tool",
      content: '{"results":["a"]}',
      toolCallId: "tc-1",
    });
  });

  it("skips tool result for non-output-available state", () => {
    const msgs: UIMessage[] = [
      makeMessage("assistant", [
        makeToolPart(
          "tc-1",
          "web_search",
          { query: "test" },
          "input-available"
        ),
      ]),
    ];
    const dtos = uiMessagesToMessageDtos(msgs);
    // Should have assistant with tool call but no tool result message
    expect(dtos).toHaveLength(1);
    expect(dtos[0]?.role).toBe("assistant");
    expect(dtos[0]?.toolCalls).toHaveLength(1);
  });

  it("skips system messages", () => {
    const msgs: UIMessage[] = [
      { id: "sys-1", role: "system", parts: [makeTextPart("system prompt")] },
      makeMessage("user", [makeTextPart("hello")]),
    ];
    const dtos = uiMessagesToMessageDtos(msgs);
    expect(dtos).toHaveLength(1);
    expect(dtos[0]?.role).toBe("user");
  });

  it("handles multi-turn conversation", () => {
    const msgs: UIMessage[] = [
      makeMessage("user", [makeTextPart("turn 1")]),
      makeMessage("assistant", [makeTextPart("response 1")]),
      makeMessage("user", [makeTextPart("turn 2")]),
      makeMessage("assistant", [makeTextPart("response 2")]),
    ];
    const dtos = uiMessagesToMessageDtos(msgs);
    expect(dtos).toHaveLength(4);
    expect(dtos.map((d) => d.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("joins multiple text parts with newline", () => {
    const msgs: UIMessage[] = [
      makeMessage("user", [makeTextPart("line 1"), makeTextPart("line 2")]),
    ];
    const dtos = uiMessagesToMessageDtos(msgs);
    expect(dtos[0]?.content).toBe("line 1\nline 2");
  });

  it("round-trip: tool call persisted as UIMessage reconstructs identical DTOs", () => {
    // Simulate what the route persists after a tool-calling turn:
    // user message + assistant message with text + dynamic-tool parts
    const persistedThread: UIMessage[] = [
      makeMessage("user", [makeTextPart("search for cats")]),
      makeMessage("assistant", [
        makeTextPart("Let me search for that."),
        makeToolPart(
          "call-abc",
          "web_search",
          { query: "cats" },
          "output-available",
          { results: [{ title: "Cats", url: "https://example.com" }] }
        ),
        makeToolPart(
          "call-def",
          "metrics_query",
          { metric: "cpu_usage" },
          "output-available",
          { value: 42.5 }
        ),
      ]),
      makeMessage("user", [makeTextPart("thanks")]),
      makeMessage("assistant", [makeTextPart("You're welcome!")]),
    ];

    const dtos = uiMessagesToMessageDtos(persistedThread);

    // Turn 1: user
    expect(dtos[0]).toEqual({ role: "user", content: "search for cats" });

    // Turn 1: assistant with 2 tool calls
    expect(dtos[1]).toEqual({
      role: "assistant",
      content: "Let me search for that.",
      toolCalls: [
        { id: "call-abc", name: "web_search", arguments: '{"query":"cats"}' },
        {
          id: "call-def",
          name: "metrics_query",
          arguments: '{"metric":"cpu_usage"}',
        },
      ],
    });

    // Turn 1: tool results (one per completed tool call)
    expect(dtos[2]).toEqual({
      role: "tool",
      content: '{"results":[{"title":"Cats","url":"https://example.com"}]}',
      toolCallId: "call-abc",
    });
    expect(dtos[3]).toEqual({
      role: "tool",
      content: '{"value":42.5}',
      toolCallId: "call-def",
    });

    // Turn 2: user + assistant (no tools)
    expect(dtos[4]).toEqual({ role: "user", content: "thanks" });
    expect(dtos[5]).toEqual({ role: "assistant", content: "You're welcome!" });

    expect(dtos).toHaveLength(6);
  });
});
