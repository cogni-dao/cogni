// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/services/assemble-assistant-message`
 * Purpose: Shared builder: AiEvent[] → persisted assistant UIMessage.
 * Scope: Pure function. Converts accumulated AiEvents into a UIMessage suitable for thread persistence.
 * Invariants:
 *   - IDEMPOTENT_THREAD_PERSIST: message.id = `assistant-{runId}` (deterministic)
 *   - TERMINAL_ONLY_PERSIST: returns null if no assistant_final received (error runs)
 *   - SHARED_EVENT_ASSEMBLER: single source of truth for event→message conversion
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/internal/graphs/[graphId]/runs/route.ts, ai-events.ts
 * @public
 */

import type { AiEvent } from "@cogni/ai-core";
import type { UIMessage } from "ai";

/**
 * Assemble a persisted assistant UIMessage from a sequence of AiEvents.
 *
 * Returns null if no `assistant_final` event was received (error/aborted runs).
 * Per TERMINAL_ONLY_PERSIST: partial text_deltas without authoritative final are not persisted.
 *
 * Message ID is deterministic (`assistant-{runId}`) for idempotent persistence.
 * On retry, callers check if a message with this ID already exists in the thread.
 */
export function assembleAssistantMessage(
  runId: string,
  events: readonly AiEvent[]
): UIMessage | null {
  let assistantFinalContent: string | undefined;
  const toolParts: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
    output?: unknown;
    state: "input-available" | "output-available";
  }> = [];
  const toolPartIndex = new Map<string, number>();

  for (const event of events) {
    if (event.type === "assistant_final") {
      assistantFinalContent = event.content;
    } else if (event.type === "tool_call_start") {
      const idx = toolParts.length;
      toolParts.push({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.args ?? {},
        state: "input-available",
      });
      toolPartIndex.set(event.toolCallId, idx);
    } else if (event.type === "tool_call_result") {
      const idx = toolPartIndex.get(event.toolCallId);
      if (idx !== undefined) {
        const part = toolParts[idx];
        if (part) {
          part.output = event.result;
          part.state = "output-available";
        }
      }
    }
  }

  // TERMINAL_ONLY_PERSIST: no assistant_final = no persistence
  if (assistantFinalContent === undefined) {
    return null;
  }

  const parts: UIMessage["parts"] = [];
  if (assistantFinalContent) {
    parts.push({ type: "text" as const, text: assistantFinalContent });
  }
  for (const tp of toolParts) {
    parts.push({
      type: "dynamic-tool",
      toolCallId: tp.toolCallId,
      toolName: tp.toolName,
      state: tp.state,
      input: tp.input,
      ...(tp.output !== undefined ? { output: tp.output } : {}),
    } as UIMessage["parts"][number]);
  }

  return {
    id: `assistant-${runId}`,
    role: "assistant",
    parts,
  };
}
