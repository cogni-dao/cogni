// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/langgraph-graphs/inproc/runner-structured-output`
 * Purpose: Integration test proving structuredOutput flows through runner + real pr-review graph.
 * Scope: Exercises createInProcGraphRunner with responseFormat and mock completionFn. Does NOT make real LLM calls.
 * Invariants: structuredOutput present when responseFormat is set, absent when not.
 * Side-effects: none (all mocked via ALS)
 * Links: runner.ts, pr-review/graph.ts
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import { knowledgeReadContract } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPrReviewGraph } from "../../src/graphs/pr-review/graph";
import { createInProcGraphRunner } from "../../src/inproc/runner";
import type {
  CompletionFn,
  InProcGraphRequest,
  ToolExecFn,
} from "../../src/inproc/types";

const TestEvalSchema = z.object({
  metrics: z.array(
    z.object({
      metric: z.string(),
      value: z.number().min(0).max(1),
      observations: z.array(z.string()),
    })
  ),
  summary: z.string(),
});

/** pr-review is hub-grounded: it requires node identity, a mission and a governing index. */
const SOURCE_CONTEXT = {
  nodeId: "node-1",
  origin: "https://operator.example",
  mission: {
    content: "Run the node network.",
    sourceRef: ".cogni/repo-spec.yaml#intent.mission",
    buildSha: "b".repeat(40),
  },
  governingIndex: [
    {
      id: "no-secrets-in-logs",
      domain: "method",
      entryType: "rule",
      useWhen: "logging",
    },
  ],
};

const VALID_JSON_RESPONSE = JSON.stringify({
  metrics: [
    { metric: "coherent-change", value: 0.9, observations: ["looks good"] },
  ],
  summary: "Solid PR",
});

describe("runner + pr-review graph with responseFormat", () => {
  it("returns structuredOutput when responseFormat is provided", async () => {
    const completionFn: CompletionFn = () => ({
      stream: (async function* (): AsyncIterable<AiEvent> {
        yield { type: "text_delta", delta: VALID_JSON_RESPONSE };
      })(),
      final: Promise.resolve({
        ok: true as const,
        content: VALID_JSON_RESPONSE,
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: "stop",
      }),
    });

    const request: InProcGraphRequest = {
      runId: "test-structured",
      messages: [{ role: "user", content: "Evaluate this PR" }],
      configurable: { model: "test-model" },
    };

    const { stream, final } = createInProcGraphRunner({
      createGraph: (opts) => createPrReviewGraph(opts),
      sourceContext: SOURCE_CONTEXT,
      completionFn,
      createToolExecFn: (): ToolExecFn => async () => ({ ok: true, value: {} }),
      toolContracts: [],
      request,
      responseFormat: {
        prompt: "Return JSON with metrics array and summary string.",
        schema: TestEvalSchema,
      },
    });

    for await (const _event of stream) {
      // drain
    }

    const result = await final;
    expect(result.ok).toBe(true);
    expect(result.structuredOutput).toBeDefined();
    expect(result.structuredOutput).toHaveProperty("metrics");
    expect(result.structuredOutput).toHaveProperty("summary");
    // Host fields added by finalize (story.5102), never model-written.
    expect(result.structuredOutput).toMatchObject({
      evidence: { files: [], entries: [] },
      uncited: false,
      buildSha: "b".repeat(40),
    });
  });

  it("fails the run when the governing index is empty (requireIndex)", async () => {
    const completionFn: CompletionFn = () => ({
      stream: (async function* (): AsyncIterable<AiEvent> {})(),
      final: Promise.resolve({
        ok: true as const,
        content: VALID_JSON_RESPONSE,
        finishReason: "stop",
      }),
    });
    const { stream, final } = createInProcGraphRunner({
      createGraph: (opts) => createPrReviewGraph(opts),
      sourceContext: { ...SOURCE_CONTEXT, governingIndex: [] },
      completionFn,
      createToolExecFn: (): ToolExecFn => async () => ({ ok: true, value: {} }),
      toolContracts: [],
      request: {
        runId: "test-no-index",
        messages: [{ role: "user", content: "Evaluate this PR" }],
        configurable: { model: "test-model" },
      },
      responseFormat: { schema: TestEvalSchema },
    });
    for await (const _event of stream) {
      // drain
    }
    const result = await final;
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("governing_index_unavailable");
  });

  it("returns NO structuredOutput when responseFormat is absent", async () => {
    const completionFn: CompletionFn = () => ({
      stream: (async function* (): AsyncIterable<AiEvent> {
        yield { type: "text_delta", delta: "plain text" };
      })(),
      final: Promise.resolve({
        ok: true as const,
        content: "plain text",
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: "stop",
      }),
    });

    const request: InProcGraphRequest = {
      runId: "test-no-format",
      messages: [{ role: "user", content: "Evaluate this PR" }],
      configurable: { model: "test-model" },
    };

    const { stream, final } = createInProcGraphRunner({
      createGraph: (opts) => createPrReviewGraph(opts),
      sourceContext: SOURCE_CONTEXT,
      completionFn,
      createToolExecFn: (): ToolExecFn => async () => ({ ok: true, value: {} }),
      toolContracts: [],
      request,
    });

    for await (const _event of stream) {
      // drain
    }

    const result = await final;
    expect(result.ok).toBe(true);
    expect(result.structuredOutput).toBeUndefined();
  });

  it("runs tools in gather, then a tool-free structured verdict, and counts what was read (story.5102)", async () => {
    const verdictJson = JSON.stringify({
      metrics: [
        {
          metric: "complies-with-governing-hub-rules",
          value: 0.1,
          observations: ["logs a token"],
          citations: ["no-secrets-in-logs"],
        },
      ],
      summary: "breaks no-secrets-in-logs",
    });
    const toolsOffered: number[] = [];
    let call = 0;
    const completionFn: CompletionFn = (params) => {
      call++;
      toolsOffered.push(params.tools?.length ?? 0);
      const content =
        call === 1 ? "" : call === 2 ? "I have read enough." : verdictJson;
      return {
        stream: (async function* (): AsyncIterable<AiEvent> {})(),
        final: Promise.resolve({
          ok: true as const,
          content,
          ...(call === 1
            ? {
                toolCalls: [
                  {
                    id: "call-read-1",
                    type: "function" as const,
                    function: {
                      name: "core__knowledge_read",
                      arguments: JSON.stringify({ id: "no-secrets-in-logs" }),
                    },
                  },
                ],
              }
            : {}),
          finishReason: call === 1 ? "tool_calls" : "stop",
        }),
      };
    };
    const { stream, final } = createInProcGraphRunner({
      createGraph: (opts) => createPrReviewGraph(opts),
      sourceContext: SOURCE_CONTEXT,
      completionFn,
      createToolExecFn: (): ToolExecFn => async () => ({
        ok: true,
        value: {
          mode: "get",
          entries: [
            { id: "no-secrets-in-logs", content: "Never log secrets." },
          ],
          totalFound: 1,
        },
      }),
      toolContracts: [knowledgeReadContract],
      request: {
        runId: "test-tools-then-verdict",
        messages: [{ role: "user", content: "Evaluate this PR" }],
        configurable: {
          model: "test-model",
          toolIds: ["core__knowledge_read"],
        },
      },
      // The production `evaluation-output` schema carries per-metric citations.
      responseFormat: {
        schema: z.object({
          metrics: z.array(
            z.object({
              metric: z.string(),
              value: z.number().min(0).max(1),
              observations: z.array(z.string()),
              citations: z.array(z.string()).optional(),
            })
          ),
          summary: z.string(),
          insufficientEvidence: z.boolean().optional(),
        }),
      },
    });
    for await (const _event of stream) {
      // drain
    }
    const result = await final;
    expect(result.ok).toBe(true);
    // Gather calls are offered the tool; the verdict call is tool-free.
    expect(toolsOffered).toEqual([1, 1, 0]);
    expect(result.structuredOutput).toMatchObject({
      evidence: { files: [], entries: ["no-secrets-in-logs"] },
      uncited: false,
    });
  });
});
