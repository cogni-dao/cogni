// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/ai/services/assemble-assistant-message`
 * Purpose: Unit tests for the shared AiEvent[] → UIMessage assembler.
 * Scope: Verifies deterministic message ID, terminal-only semantics, and tool part assembly.
 * Invariants: IDEMPOTENT_THREAD_PERSIST, TERMINAL_ONLY_PERSIST, SHARED_EVENT_ASSEMBLER
 * Side-effects: none
 * Links: nodes/operator/app/src/features/ai/services/assemble-assistant-message.ts
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import { describe, expect, it } from "vitest";
import { assembleAssistantMessage } from "@/features/ai/services/assemble-assistant-message";

const RUN_ID = "test-run-001";

describe("assembleAssistantMessage", () => {
  it("returns null when no assistant_final event (error run)", () => {
    const events: AiEvent[] = [
      { type: "text_delta", delta: "partial" },
      { type: "error", error: "internal" },
    ];
    expect(assembleAssistantMessage(RUN_ID, events)).toBeNull();
  });

  it("returns null for empty event list", () => {
    expect(assembleAssistantMessage(RUN_ID, [])).toBeNull();
  });

  it("assembles text-only message from assistant_final", () => {
    const events: AiEvent[] = [
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " world" },
      { type: "assistant_final", content: "Hello world" },
      { type: "done" },
    ];
    const msg = assembleAssistantMessage(RUN_ID, events);
    expect(msg).not.toBeNull();
    expect(msg?.id).toBe(`assistant-${RUN_ID}`);
    expect(msg?.role).toBe("assistant");
    expect(msg?.parts).toHaveLength(1);
    expect(msg?.parts[0]).toEqual({ type: "text", text: "Hello world" });
  });

  it("uses deterministic message ID from runId", () => {
    const events: AiEvent[] = [
      { type: "assistant_final", content: "test" },
      { type: "done" },
    ];
    const msg1 = assembleAssistantMessage("run-aaa", events);
    const msg2 = assembleAssistantMessage("run-aaa", events);
    expect(msg1?.id).toBe("assistant-run-aaa");
    expect(msg1?.id).toBe(msg2?.id);
  });

  it("assembles tool call parts", () => {
    const events: AiEvent[] = [
      {
        type: "tool_call_start",
        toolCallId: "tc-1",
        toolName: "search",
        args: { query: "test" },
      },
      {
        type: "tool_call_result",
        toolCallId: "tc-1",
        result: { hits: 3 },
      },
      { type: "assistant_final", content: "Found 3 results" },
      { type: "done" },
    ];
    const msg = assembleAssistantMessage(RUN_ID, events);
    expect(msg).not.toBeNull();
    expect(msg?.parts).toHaveLength(2); // text + tool
    const toolPart = msg?.parts[1];
    expect(toolPart).toMatchObject({
      type: "dynamic-tool",
      toolCallId: "tc-1",
      toolName: "search",
      state: "output-available",
      input: { query: "test" },
      output: { hits: 3 },
    });
  });

  it("handles tool_call_start without result (partial tool execution)", () => {
    const events: AiEvent[] = [
      {
        type: "tool_call_start",
        toolCallId: "tc-1",
        toolName: "search",
        args: {},
      },
      { type: "assistant_final", content: "Interrupted" },
      { type: "done" },
    ];
    const msg = assembleAssistantMessage(RUN_ID, events);
    expect(msg?.parts).toHaveLength(2);
    const toolPart = msg?.parts[1];
    expect(toolPart).toMatchObject({
      type: "dynamic-tool",
      toolCallId: "tc-1",
      state: "input-available",
    });
  });

  it("ignores usage_report and status events", () => {
    const events: AiEvent[] = [
      { type: "status", phase: "thinking" },
      {
        type: "usage_report",
        fact: {
          runId: RUN_ID,
          model: "test",
          promptTokens: 10,
          completionTokens: 5,
          callId: "c-1",
        },
      },
      { type: "assistant_final", content: "result" },
      { type: "done" },
    ];
    const msg = assembleAssistantMessage(RUN_ID, events);
    expect(msg?.parts).toHaveLength(1);
    expect(msg?.parts[0]).toEqual({ type: "text", text: "result" });
  });
});
