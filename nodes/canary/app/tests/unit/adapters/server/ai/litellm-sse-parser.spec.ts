// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/litellm-sse-parser.spec`
 * Purpose: Unit tests for LiteLLM adapter's eventsource-parser integration.
 * Scope: Validates adapter handles arbitrary SSE chunk splits via eventsource-parser. Does not test full completion flow.
 * Invariants: Chunk splits at any offset → identical ChatDeltaEvents
 * Side-effects: none
 * Notes: Tests critical path for streaming correctness using eventsource-parser
 * Links: src/adapters/server/ai/litellm.adapter.ts
 * @internal
 */

import { createParser } from "eventsource-parser";
import { describe, expect, it } from "vitest";

/**
 * Helper: Simulate the adapter's SSE parsing logic
 * This mirrors the actual implementation in litellm.adapter.ts
 */
async function* simulateAdapterParsing(chunks: string[]) {
  const eventQueue: Array<{ data: string }> = [];
  const parser = createParser({
    onEvent(event) {
      eventQueue.push(event);
    },
  });

  for (const chunk of chunks) {
    parser.feed(chunk);

    while (eventQueue.length > 0) {
      const event = eventQueue.shift();
      if (!event) break;
      const data = event.data;

      if (data === "[DONE]") {
        yield { type: "done" } as const;
        continue;
      }

      try {
        const json = JSON.parse(data);
        const content = json.choices?.[0]?.delta?.content;
        if (content) {
          yield { type: "text_delta", delta: content } as const;
        }
      } catch (parseError) {
        const errorMessage =
          parseError instanceof Error ? parseError.message : "JSON parse error";
        yield {
          type: "error",
          error: `Malformed response: ${errorMessage}`,
        } as const;
      }
    }
  }
}

/**
 * Helper: Collect all events from async generator
 */
async function collectEvents(
  generator: AsyncIterable<{ type: string; delta?: string; error?: string }>
) {
  const events: Array<{ type: string; delta?: string; error?: string }> = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

describe("LiteLLM Adapter - eventsource-parser Integration", () => {
  describe("Chunk Boundary Handling", () => {
    it("should handle event split across 3+ chunks mid-JSON", async () => {
      // Simulates network chunking splitting JSON payload
      const chunks = [
        'data: {"choi',
        'ces":[{"delta',
        '":{"content":"hello"}}]}\n\n',
      ];

      const events = await collectEvents(simulateAdapterParsing(chunks));

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("text_delta");
      expect(events[0]?.delta).toBe("hello");
    });

    it("should handle two events where boundary occurs mid-second-event", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
        "da",
        'ta: {"choices":[{"delta":{"content":"second"}}]}\n\n',
      ];

      const events = await collectEvents(simulateAdapterParsing(chunks));

      expect(events).toHaveLength(2);
      expect(events[0]?.delta).toBe("first");
      expect(events[1]?.delta).toBe("second");
    });

    it("should handle event split at newline boundary", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"test"}}]}\n',
        "\n",
      ];

      const events = await collectEvents(simulateAdapterParsing(chunks));

      expect(events).toHaveLength(1);
      expect(events[0]?.delta).toBe("test");
    });

    it("should handle multiple events in single chunk", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"one"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"two"}}]}\n\n',
      ];

      const events = await collectEvents(simulateAdapterParsing(chunks));

      expect(events).toHaveLength(2);
      expect(events[0]?.delta).toBe("one");
      expect(events[1]?.delta).toBe("two");
    });
  });

  describe("[DONE] Terminator", () => {
    it("should handle [DONE] terminator from LiteLLM/OpenAI", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"text"}}]}\n\n',
        "data: [DONE]\n\n",
      ];

      const events = await collectEvents(simulateAdapterParsing(chunks));

      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe("text_delta");
      expect(events[0]?.delta).toBe("text");
      expect(events[1]?.type).toBe("done");
    });

    it("should handle [DONE] split across chunks", async () => {
      const chunks = ["data: [DO", "NE]\n\n"];

      const events = await collectEvents(simulateAdapterParsing(chunks));

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("done");
    });
  });

  describe("Malformed Input", () => {
    it("should emit error event for malformed JSON", async () => {
      const chunks = [
        "data: {invalid json no quotes\n\n",
        'data: {"choices":[{"delta":{"content":"valid"}}]}\n\n',
      ];

      const events = await collectEvents(simulateAdapterParsing(chunks));

      // Should emit error event for malformed, then valid event
      expect(events.length).toBeGreaterThanOrEqual(1);
      const errorEvents = events.filter((e) => e.type === "error");
      const validEvents = events.filter((e) => e.type === "text_delta");

      expect(errorEvents.length).toBeGreaterThan(0);
      expect(validEvents.length).toBeGreaterThan(0);
      expect(validEvents[0]?.delta).toBe("valid");
    });

    it("should not emit unexpected done events on malformed input", async () => {
      const chunks = [
        "data: {malformed\n\n",
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      ];

      const events = await collectEvents(simulateAdapterParsing(chunks));

      const doneEvents = events.filter((e) => e.type === "done");
      expect(doneEvents).toHaveLength(0); // No done unless explicit [DONE]
    });
  });

  describe("Empty/Edge Cases", () => {
    it("should handle empty stream", async () => {
      const chunks: string[] = [];
      const events = await collectEvents(simulateAdapterParsing(chunks));
      expect(events).toHaveLength(0);
    });

    it("should handle chunk with only comments", async () => {
      const chunks = [": this is a comment\n", ": another comment\n\n"];
      const events = await collectEvents(simulateAdapterParsing(chunks));
      // Comments are ignored by eventsource-parser
      expect(events).toHaveLength(0);
    });

    it("should handle delta with no content field", async () => {
      const chunks = ['data: {"choices":[{"delta":{}}]}\n\n'];
      const events = await collectEvents(simulateAdapterParsing(chunks));
      // No content → no text_delta event
      expect(events).toHaveLength(0);
    });
  });
});
