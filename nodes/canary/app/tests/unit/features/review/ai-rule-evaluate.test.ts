// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/review/ai-rule-evaluate`
 * Purpose: Unit tests for evaluateAiRule structured output consumption.
 * Scope: Tests evaluateAiRule with a mock GraphExecutorPort returning structuredOutput. Does NOT test real LLM calls.
 * Invariants: evaluateAiRule reads structuredOutput from GraphFinal, maps metrics to scores, applies criteria.
 * Side-effects: none
 * Links: task.0153
 * @public
 */

import type { Rule } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";
import { evaluateAiRule } from "@/features/review/gates/ai-rule";
import type { EvidenceBundle } from "@/features/review/types";
import type { GraphExecutorPort, GraphRunResult, LlmCaller } from "@/ports";

const evidence: EvidenceBundle = {
  prNumber: 1,
  prTitle: "feat: add widget",
  prBody: "Adds a widget",
  headSha: "abc123",
  baseBranch: "main",
  changedFiles: 2,
  additions: 30,
  deletions: 5,
  patches: [{ filename: "widget.ts", patch: "+export class Widget {}" }],
  totalDiffBytes: 500,
};

const caller: LlmCaller = {
  billingAccountId: "system",
  virtualKeyId: "vk-test",
  traceId: "trace-test",
  sessionId: "session-test",
};

const rule: Rule = {
  id: "code-quality",
  blocking: true,
  evaluations: [
    { "coherent-change": "Is the PR a coherent, self-contained change?" },
    { "non-malicious": "Does the code appear safe and non-malicious?" },
  ],
  success_criteria: {
    require: [{ metric: "coherent-change", gte: 0.7 }],
    neutral_on_missing_metrics: true,
  },
};

function makeMockExecutor(
  structuredOutput?: Record<string, unknown>,
  ok = true,
  error?: string
): GraphExecutorPort {
  return {
    runGraph: (): GraphRunResult => ({
      stream: (async function* () {
        yield { type: "done" as const };
      })(),
      final: Promise.resolve({
        ok,
        runId: "run-1",
        requestId: "run-1",
        ...(ok && { finishReason: "stop", content: "" }),
        ...(!ok && { error }),
        ...(structuredOutput !== undefined && { structuredOutput }),
      }),
    }),
  };
}

describe("evaluateAiRule", () => {
  it("extracts scores from structuredOutput and passes criteria", async () => {
    const executor = makeMockExecutor({
      metrics: [
        {
          metric: "coherent-change",
          value: 0.9,
          observations: ["Well-structured change"],
        },
        {
          metric: "non-malicious",
          value: 1.0,
          observations: ["No issues found"],
        },
      ],
      summary: "Looks good.",
    });

    const result = await evaluateAiRule({
      rule,
      evidence,
      executor,
      caller,
      model: "test-model",
    });

    expect(result.status).toBe("pass");
    expect(result.metrics).toHaveLength(2);
    expect(result.metrics?.[0]).toEqual({
      metric: "coherent-change",
      score: 0.9,
      requirement: "\u2265 0.70 (all)",
      observation: "Well-structured change",
    });
  });

  it("returns fail when scores below threshold", async () => {
    const executor = makeMockExecutor({
      metrics: [
        {
          metric: "coherent-change",
          value: 0.3,
          observations: ["Incoherent"],
        },
      ],
      summary: "Needs work.",
    });

    const result = await evaluateAiRule({
      rule,
      evidence,
      executor,
      caller,
      model: "test-model",
    });

    expect(result.status).toBe("fail");
  });

  it("returns neutral when structuredOutput is missing", async () => {
    const executor = makeMockExecutor(undefined);

    const result = await evaluateAiRule({
      rule,
      evidence,
      executor,
      caller,
      model: "test-model",
    });

    // neutral_on_missing_metrics: true in our rule
    expect(result.status).toBe("neutral");
  });

  it("returns neutral on executor failure", async () => {
    const executor = makeMockExecutor(undefined, false, "rate_limit");

    const result = await evaluateAiRule({
      rule,
      evidence,
      executor,
      caller,
      model: "test-model",
    });

    expect(result.status).toBe("neutral");
    expect(result.summary).toContain("rate_limit");
  });

  it("filters out metrics not in rule evaluations", async () => {
    const executor = makeMockExecutor({
      metrics: [
        {
          metric: "coherent-change",
          value: 0.8,
          observations: ["Good"],
        },
        {
          metric: "unknown-metric",
          value: 0.5,
          observations: ["Should be ignored"],
        },
      ],
      summary: "Done.",
    });

    const result = await evaluateAiRule({
      rule,
      evidence,
      executor,
      caller,
      model: "test-model",
    });

    expect(result.metrics).toHaveLength(1);
    expect(result.metrics?.[0]?.metric).toBe("coherent-change");
  });

  it("joins multiple observations with semicolons", async () => {
    const executor = makeMockExecutor({
      metrics: [
        {
          metric: "coherent-change",
          value: 0.85,
          observations: ["First note", "Second note"],
        },
      ],
      summary: "Done.",
    });

    const result = await evaluateAiRule({
      rule,
      evidence,
      executor,
      caller,
      model: "test-model",
    });

    expect(result.metrics?.[0]?.observation).toBe("First note; Second note");
  });
});
