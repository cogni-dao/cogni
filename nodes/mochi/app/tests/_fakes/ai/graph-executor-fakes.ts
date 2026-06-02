// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/ai/graph-executor-fakes`
 * Purpose: Fake GraphExecutorPort implementations for unit testing RunEventRelay.
 * Scope: Creates controllable graph executors with configurable event streams. Does not perform real LLM calls.
 * Invariants: Executors return synchronously per GraphExecutorPort contract.
 * Side-effects: none
 * Links: src/ports/graph-executor.port.ts, ai_runtime.ts (RunEventRelay)
 * @public
 */

import type { AiEvent } from "@cogni/node-core";
import type {
  GraphExecutorPort,
  GraphRunRequest,
  GraphRunResult,
} from "@/ports";

/**
 * Create a fake graph executor that yields all events immediately.
 * Simulates the race condition where pump finishes between uiStream()'s drain and wait phases.
 */
export function createImmediateGraphExecutor(
  events: AiEvent[]
): GraphExecutorPort {
  return {
    runGraph(_req: GraphRunRequest): GraphRunResult {
      async function* fastStream(): AsyncIterable<AiEvent> {
        for (const event of events) {
          yield event;
        }
      }
      return {
        stream: fastStream(),
        final: Promise.resolve({
          ok: true as const,
          runId: "run-123",
          requestId: "req-123",
          usage: { promptTokens: 10, completionTokens: 5 },
          finishReason: "stop",
        }),
      };
    },
  };
}

/**
 * Create a graph executor where the upstream continues AFTER yielding done.
 * Simulates production: LLM yields done, but iterator doesn't return immediately
 * (e.g., adapter awaits final promise before returning).
 * Key: uiStream must terminate on done event, not wait for pumpDone.
 */
export function createDelayedReturnGraphExecutor(
  events: AiEvent[],
  delayAfterDoneMs: number
): GraphExecutorPort {
  return {
    runGraph(_req: GraphRunRequest): GraphRunResult {
      async function* slowReturnStream(): AsyncIterable<AiEvent> {
        for (const event of events) {
          yield event;
          if (event.type === "done") {
            await new Promise((r) => setTimeout(r, delayAfterDoneMs));
          }
        }
      }
      return {
        stream: slowReturnStream(),
        final: Promise.resolve({
          ok: true as const,
          runId: "run-123",
          requestId: "req-123",
          usage: { promptTokens: 10, completionTokens: 5 },
          finishReason: "stop",
        }),
      };
    },
  };
}
