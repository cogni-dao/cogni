// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/codex/codex-item-delta`
 * Purpose: Unit tests for Codex agent_message delta extraction logic.
 * Scope: Validates that per-item text tracking resets on item.started, preventing
 *   lossy output when Codex emits multiple agent_message items (e.g., after tool calls).
 * Invariants: Each agent_message item tracked independently; no global state leak.
 * Side-effects: none
 * Links: codex-llm.adapter.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

/**
 * Pure extraction of the delta logic from codex-llm.adapter.ts runCodexExec().
 * Processes a sequence of Codex SDK events and returns the text deltas emitted.
 */
function extractDeltas(
  events: Array<{
    type: "item.started" | "item.updated" | "item.completed" | "turn.completed";
    item?: { type: string; text: string };
    usage?: { input_tokens: number; output_tokens: number };
  }>
): string[] {
  let itemText = "";
  const deltas: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case "item.started": {
        if (event.item?.type === "agent_message") {
          itemText = "";
        }
        break;
      }
      case "item.updated":
      case "item.completed": {
        if (event.item?.type === "agent_message") {
          const newText = event.item.text;
          if (newText.length > itemText.length) {
            const delta = newText.slice(itemText.length);
            itemText = newText;
            deltas.push(delta);
          }
        }
        break;
      }
    }
  }

  return deltas;
}

describe("Codex agent_message delta extraction", () => {
  it("extracts deltas from a single agent_message", () => {
    const events = [
      {
        type: "item.started" as const,
        item: { type: "agent_message", text: "" },
      },
      {
        type: "item.updated" as const,
        item: { type: "agent_message", text: "Hello" },
      },
      {
        type: "item.updated" as const,
        item: { type: "agent_message", text: "Hello world" },
      },
      {
        type: "item.completed" as const,
        item: { type: "agent_message", text: "Hello world" },
      },
    ];

    const deltas = extractDeltas(events);
    expect(deltas).toEqual(["Hello", " world"]);
    expect(deltas.join("")).toBe("Hello world");
  });

  it("handles multiple agent_messages after tool calls (the production bug)", () => {
    // Codex flow: agent_message #1 → tool_call → agent_message #2
    // Bug: global fullText from message #1 causes message #2 deltas to be dropped
    const events = [
      // First agent message
      {
        type: "item.started" as const,
        item: { type: "agent_message", text: "" },
      },
      {
        type: "item.updated" as const,
        item: { type: "agent_message", text: "Let me check" },
      },
      {
        type: "item.completed" as const,
        item: { type: "agent_message", text: "Let me check" },
      },
      // Tool call happens (different item type, not agent_message)
      { type: "item.started" as const, item: { type: "tool_call", text: "" } },
      {
        type: "item.completed" as const,
        item: { type: "tool_call", text: "" },
      },
      // Second agent message — starts fresh with text=""
      {
        type: "item.started" as const,
        item: { type: "agent_message", text: "" },
      },
      {
        type: "item.updated" as const,
        item: { type: "agent_message", text: "Here are" },
      },
      {
        type: "item.updated" as const,
        item: { type: "agent_message", text: "Here are the results" },
      },
      {
        type: "item.completed" as const,
        item: { type: "agent_message", text: "Here are the results" },
      },
    ];

    const deltas = extractDeltas(events);
    expect(deltas).toEqual(["Let me check", "Here are", " the results"]);
    // Both messages' content is captured — nothing lost
    expect(deltas.join("")).toBe("Let me checkHere are the results");
  });
});
