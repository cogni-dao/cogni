// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/inproc-completion-unit.max-tokens.spec`
 * Purpose: Prove the per-call output-token cap reaches the completion layer, and that the host default is unchanged when a graph sets none.
 * Scope: executeCompletionUnit maxTokens wiring only. Does NOT make LLM calls.
 * Invariants: OUTPUT_CAP_IS_PER_CALL (bug.5626): a graph's cap overrides the host default for that call only; absent cap keeps 32768.
 * Side-effects: none
 * Links: inproc-completion-unit.adapter.ts, packages/langgraph-graphs/src/graphs/pr-review/graph.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import { runInScope } from "@/adapters/server/ai/execution-scope";
import {
  type CompletionStreamParams,
  InProcCompletionUnitAdapter,
} from "@/adapters/server/ai/inproc-completion-unit.adapter";

const TEST_SCOPE = {
  billing: { billingAccountId: "billing-123", virtualKeyId: "vk-123" },
  usageSource: "litellm" as const,
};

async function seenMaxTokens(maxTokens?: number): Promise<number | undefined> {
  let seen: number | undefined;
  await runInScope(TEST_SCOPE, async () => {
    const adapter = new InProcCompletionUnitAdapter(
      {
        llmService: {} as never,
        accountService: {} as never,
        clock: {} as never,
        aiTelemetry: {} as never,
        langfuse: undefined,
      },
      async (params: CompletionStreamParams) => {
        seen = params.maxTokens;
        return {
          stream: (async function* () {})(),
          final: Promise.resolve({
            ok: true as const,
            requestId: "req-1",
            content: "x",
            usage: { promptTokens: 1, completionTokens: 1 },
            finishReason: "stop",
          }),
        };
      }
    );
    const result = adapter.executeCompletionUnit({
      messages: [{ role: "user", content: "test" }],
      model: "test-model",
      runContext: {
        runId: "run-1",
        attempt: 0,
        graphId: "langgraph:test" as import("@cogni/ai-core").GraphId,
      },
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
    await result.final;
  });
  return seen;
}

describe("InProcCompletionUnitAdapter output-token cap (bug.5626)", () => {
  it("keeps the 32768 host default when the graph sets no cap", async () => {
    expect(await seenMaxTokens()).toBe(32768);
  });

  it("uses the graph's cap when it sets one", async () => {
    expect(await seenMaxTokens(8192)).toBe(8192);
  });
});
