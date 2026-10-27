// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/langgraph-graphs/runtime/with-structured-output`
 * Purpose: Unit tests for CogniCompletionAdapter.withStructuredOutput().
 * Scope: Tests JSON extraction, code fence stripping, Zod validation, error handling. Does NOT make real LLM calls.
 * Invariants: withStructuredOutput returns a Runnable that parses JSON from the LLM response.
 * Side-effects: none (all mocked via ALS)
 * Links: completion-adapter.ts
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CogniCompletionAdapter } from "../../src/runtime/cogni/completion-adapter";
import { runWithCogniExecContext } from "../../src/runtime/cogni/exec-context";

const TestSchema = z.object({
  score: z.number().min(0).max(1),
  label: z.string(),
});

/**
 * Create a fake ALS context with a completionFn that returns the given content.
 */
function withFakeCompletion(
  content: string,
  fn: () => Promise<void>
): Promise<void> {
  return runWithCogniExecContext(
    {
      completionFn: () => ({
        stream: (async function* (): AsyncIterable<AiEvent> {
          yield { type: "text_delta", delta: content };
        })(),
        final: Promise.resolve({
          ok: true as const,
          content,
          usage: { promptTokens: 10, completionTokens: 5 },
          finishReason: "stop",
        }),
      }),
      tokenSink: { push: () => {} },
      toolExecFn: async () => ({ ok: true, value: {} }),
    },
    fn
  );
}

describe("CogniCompletionAdapter.withStructuredOutput", () => {
  const adapter = new CogniCompletionAdapter();
  const config = { configurable: { model: "test-model" } };
  const messages = [new HumanMessage("test")];

  it("parses clean JSON response", async () => {
    const runnable = adapter.withStructuredOutput(TestSchema);
    await withFakeCompletion('{"score": 0.85, "label": "good"}', async () => {
      const result = await runnable.invoke(messages, config);
      expect(result).toEqual({ score: 0.85, label: "good" });
    });
  });

  it("strips markdown code fences", async () => {
    const runnable = adapter.withStructuredOutput(TestSchema);
    const fenced = '```json\n{"score": 0.5, "label": "ok"}\n```';
    await withFakeCompletion(fenced, async () => {
      const result = await runnable.invoke(messages, config);
      expect(result).toEqual({ score: 0.5, label: "ok" });
    });
  });

  it("strips fences with leading/trailing whitespace", async () => {
    const runnable = adapter.withStructuredOutput(TestSchema);
    const fenced = '  \n```json\n{"score": 0.7, "label": "trimmed"}\n```\n  ';
    await withFakeCompletion(fenced, async () => {
      const result = await runnable.invoke(messages, config);
      expect(result).toEqual({ score: 0.7, label: "trimmed" });
    });
  });

  it("throws on invalid JSON", async () => {
    const runnable = adapter.withStructuredOutput(TestSchema);
    await withFakeCompletion("not valid json {", async () => {
      await expect(runnable.invoke(messages, config)).rejects.toThrow(
        "LLM returned invalid JSON"
      );
    });
  });

  it("validates with Zod and rejects invalid values", async () => {
    const runnable = adapter.withStructuredOutput(TestSchema);
    // score > 1 should fail Zod validation
    await withFakeCompletion('{"score": 1.5, "label": "bad"}', async () => {
      await expect(runnable.invoke(messages, config)).rejects.toThrow();
    });
  });

  it("works with plain JSON Schema (no Zod .parse)", async () => {
    const jsonSchema = {
      type: "object",
      properties: { x: { type: "number" } },
    };
    const runnable = adapter.withStructuredOutput(jsonSchema);
    await withFakeCompletion('{"x": 42}', async () => {
      const result = await runnable.invoke(messages, config);
      expect(result).toEqual({ x: 42 });
    });
  });
});

// Real maintained SDK composition over the billed seam; no provider/network calls.
describe("billed BaseChatModel compatibility", () => {
  it("preserves required extraction choice and uses maintained schema feedback", async () => {
    const { createAgent, toolStrategy } = await import("langchain");
    const requests: unknown[] = [];
    await runWithCogniExecContext(
      {
        tokenSink: { push: () => {} },
        toolExecFn: async () => ({ ok: true, value: {} }),
        completionFn: (request) => {
          requests.push(request);
          const extraction = (
            request.tools as { function: { name: string } }[]
          )[0]!;
          const valid = requests.length > 1;
          return {
            stream: (async function* () {})(),
            final: Promise.resolve({
              ok: true,
              toolCalls: [
                {
                  id: `extract-${requests.length}`,
                  type: "function",
                  function: {
                    name: extraction.function.name,
                    arguments: JSON.stringify({
                      score: valid ? 0.8 : 8,
                      label: "review",
                    }),
                  },
                },
              ],
            }),
          };
        },
      },
      async () => {
        const model = new CogniCompletionAdapter().bindRun("fixture-model");
        const agent = createAgent({
          model,
          responseFormat: toolStrategy(TestSchema),
        });
        const result = await agent.invoke({
          messages: [new HumanMessage("Review the evidence")],
        });
        expect(result.structuredResponse).toEqual({
          score: 0.8,
          label: "review",
        });
      }
    );
    expect(requests).toHaveLength(2);
    for (const request of requests)
      expect(request).toMatchObject({
        model: "fixture-model",
        toolChoice: "required",
      });
    expect(JSON.stringify(requests[1])).toContain(
      "Failed to parse structured output"
    );
  });

  it("rejects an empty completion and lets maintained retry recover without replaying tools", async () => {
    const { createAgent, modelRetryMiddleware } = await import("langchain");
    const { InvalidCompletionError } = await import(
      "../../src/runtime/cogni/completion-adapter"
    );
    let calls = 0;
    await runWithCogniExecContext(
      {
        tokenSink: { push: () => {} },
        toolExecFn: async () => {
          throw new Error("no tools expected");
        },
        completionFn: () => ({
          stream: (async function* () {})(),
          final: Promise.resolve({
            ok: true,
            content: ++calls === 1 ? "" : "Evidence reviewed",
            finishReason: "stop",
          }),
        }),
      },
      async () => {
        const agent = createAgent({
          model: new CogniCompletionAdapter().bindRun(
            "fixture-model",
            undefined,
            true
          ),
          middleware: [
            modelRetryMiddleware({
              maxRetries: 1,
              initialDelayMs: 0,
              jitter: false,
              onFailure: "error",
              retryOn: (error) => error instanceof InvalidCompletionError,
            }),
          ],
        });
        expect(
          (
            await agent.invoke({ messages: [new HumanMessage("Review")] })
          ).messages.at(-1)?.content
        ).toBe("Evidence reviewed");
      }
    );
    expect(calls).toBe(2);
  });

  it("binds configless summaries to the same model, signal and usage sink", async () => {
    const signal = new AbortController().signal;
    const requests: unknown[] = [];
    const events: AiEvent[] = [];
    await runWithCogniExecContext(
      {
        tokenSink: {
          push: (event) => {
            events.push(event);
          },
        },
        toolExecFn: async () => ({ ok: true, value: {} }),
        completionFn: (request) => {
          requests.push(request);
          return {
            stream: (async function* () {
              yield { type: "text_delta" as const, delta: "summary" };
            })(),
            final: Promise.resolve({
              ok: true,
              content: "summary",
              usage: { promptTokens: 20, completionTokens: 3 },
              finishReason: "stop",
            }),
          };
        },
      },
      async () => {
        const adapter = new CogniCompletionAdapter().bindRun(
          "same-billed-model",
          signal
        );
        const summary = await adapter.invoke([new HumanMessage("Summarize")]);
        expect(summary.usage_metadata).toEqual({
          input_tokens: 20,
          output_tokens: 3,
          total_tokens: 23,
        });
        expect(summary.response_metadata.finish_reason).toBe("stop");
        await expect(
          adapter.invoke("bad model", {
            configurable: { model: "another-model" },
          })
        ).rejects.toThrow("bound_model_mismatch");
      }
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "same-billed-model",
      abortSignal: signal,
    });
    expect(events).toEqual([{ type: "text_delta", delta: "summary" }]);
  });
});
