// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/inproc-completion-unit.deadlock.spec`
 * Purpose: Test that InProcCompletionUnitAdapter.executeCompletionUnit does not deadlock when final requires stream close.
 * Scope: Reproduces the deadlock where awaiting final inside for-await prevents stream completion. Does NOT test happy-path streaming or error flows.
 * Invariants: NO_AWAIT_FINAL_IN_LOOP (must break out of for-await before awaiting final)
 * Side-effects: none
 * Links: GRAPH_EXECUTION.md, AGENT_DISCOVERY.md, inproc-completion-unit.adapter.ts
 * @internal
 */

import type { AiEvent } from "@cogni/node-core";
import { describe, expect, it } from "vitest";
import { runInScope } from "@/adapters/server/ai/execution-scope";
import { InProcCompletionUnitAdapter } from "@/adapters/server/ai/inproc-completion-unit.adapter";
import type { ChatDeltaEvent } from "@/ports";

const TEST_SCOPE = {
  billing: {
    billingAccountId: "billing-123",
    virtualKeyId: "vk-123",
  },
  usageSource: "litellm" as const,
};

/**
 * Creates a fake completion stream that simulates LiteLLM behavior:
 * - Stream yields text_delta events then done
 * - `final` promise only resolves when iterator.return() is called (in finally block)
 *
 * This reproduces the deadlock: if adapter awaits final inside for-await loop,
 * the iterator never closes, finally never runs, final never resolves → hang.
 */
function createDeadlockProneCompletion() {
  let resolveIteratorClosed: () => void;
  const iteratorClosedPromise = new Promise<void>((r) => {
    resolveIteratorClosed = r;
  });

  // Stream that yields done then BLOCKS FOREVER (simulates LiteLLM behavior).
  // The only way to unblock is for the consumer to close the iterator,
  // which triggers finally and resolves iteratorClosedPromise.
  async function* fakeStream(): AsyncGenerator<ChatDeltaEvent> {
    try {
      yield { type: "text_delta", delta: "Hello " };
      yield { type: "text_delta", delta: "world" };
      yield { type: "done" };
      // Block forever after done - simulates LiteLLM not returning until closed
      await new Promise<void>(() => {});
    } finally {
      // Only runs when consumer closes iterator (breaks out of for-await)
      resolveIteratorClosed?.();
    }
  }

  // Final only resolves AFTER iterator is closed (simulates LiteLLM finally block)
  const final = iteratorClosedPromise.then(() => ({
    ok: true as const,
    requestId: "req-123",
    content: "Hello world",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    finishReason: "stop" as const,
    litellmCallId: "call-123",
    providerCostUsd: 0.001,
    model: "test-model",
  }));

  return {
    stream: fakeStream(),
    final,
  };
}

describe("InProcCompletionUnitAdapter deadlock prevention", () => {
  it("executeCompletionUnit does not deadlock when final requires stream close (NO_AWAIT_FINAL_IN_LOOP)", async () => {
    await runInScope(TEST_SCOPE, async () => {
      const adapter = new InProcCompletionUnitAdapter(
        {
          llmService: {} as never,
          accountService: {} as never,
          clock: {} as never,
          aiTelemetry: {} as never,
          langfuse: undefined,
        },
        async () => createDeadlockProneCompletion()
      );

      const result = adapter.executeCompletionUnit({
        messages: [{ role: "user", content: "test" }],
        model: "test-model",
        runContext: {
          runId: "run-123",
          attempt: 0,
          graphId: "langgraph:test" as import("@cogni/ai-core").GraphId,
        },
      });

      const collectedEvents: AiEvent[] = [];
      const TIMEOUT_MS = 500;
      const startMs = performance.now();

      const consumePromise = (async () => {
        for await (const event of result.stream) {
          collectedEvents.push(event);
        }
        return "completed";
      })();

      const timeoutPromise = new Promise<"timeout">((r) =>
        setTimeout(() => r("timeout"), TIMEOUT_MS)
      );

      const outcome = await Promise.race([consumePromise, timeoutPromise]);
      const elapsedMs = performance.now() - startMs;

      expect(outcome).toBe("completed");
      expect(elapsedMs).toBeLessThan(TIMEOUT_MS);

      const eventTypes = collectedEvents.map((e) => e.type);
      expect(eventTypes).toContain("text_delta");
      expect(eventTypes).not.toContain("done");

      const usageIndex = eventTypes.indexOf("usage_report");
      expect(usageIndex).toBeGreaterThan(-1);
      expect(collectedEvents[collectedEvents.length - 1].type).toBe(
        "usage_report"
      );
    });
  });
});
