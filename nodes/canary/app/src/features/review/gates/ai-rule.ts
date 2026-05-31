// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/review/gates/ai-rule`
 * Purpose: AI-powered gate that evaluates PRs against declarative rules via the graph executor.
 * Scope: Builds LLM message from evidence + rule, invokes graph, consumes structured output. Does not own the graph executor lifecycle.
 * Invariants: Uses GraphExecutorPort for LLM routing + billing. System tenant billing.
 * Side-effects: IO (LLM call via graph executor)
 * Links: task.0153, packages/repo-spec/src/schema.ts (Rule)
 * @public
 */

import { randomUUID } from "node:crypto";
import { LANGGRAPH_GRAPH_IDS } from "@cogni/langgraph-graphs";
import { buildReviewUserMessage } from "@cogni/langgraph-graphs/graphs";
import type { Rule } from "@cogni/repo-spec";
import { z } from "zod";

import type { GraphExecutorPort } from "@/ports";

import { evaluateCriteria, findRequirement } from "../criteria-evaluator";
import type { EvidenceBundle, GateResult } from "../types";

/**
 * Static Zod schema for structured AI rule evaluation output.
 * The LLM returns a list of metric evaluations — one per evaluation criterion.
 */
export const EvaluationOutputSchema = z.object({
  metrics: z.array(
    z.object({
      metric: z.string(),
      value: z.number().min(0).max(1),
      observations: z.array(z.string()),
    })
  ),
  summary: z.string(),
});

export type EvaluationOutput = z.infer<typeof EvaluationOutputSchema>;

/** Parsed evaluation: metric name → prompt text. */
function extractEvaluations(
  rule: Rule
): Array<{ metric: string; prompt: string }> {
  return rule.evaluations.map((entry) => {
    const entries = Object.entries(entry);
    const [metric, prompt] = entries[0] as [string, string];
    return { metric, prompt };
  });
}

/**
 * Evaluate a PR against an AI rule via the graph executor.
 */
export async function evaluateAiRule(params: {
  readonly rule: Rule;
  readonly evidence: EvidenceBundle;
  readonly executor: GraphExecutorPort;
  readonly model: string;
}): Promise<GateResult> {
  const { rule, evidence, executor, model } = params;
  const evaluations = extractEvaluations(rule);
  const metricNames = evaluations.map((e) => e.metric);

  // Build the user message with evidence + evaluation criteria
  const diffSummary = evidence.patches
    .map((p) => `### ${p.filename}\n${p.patch}`)
    .join("\n\n");

  const userMessage = buildReviewUserMessage({
    prTitle: evidence.prTitle,
    prBody: evidence.prBody,
    diffSummary,
    evaluations,
  });

  // Invoke the pr-review graph with structured output schema
  const runId = randomUUID();
  const result = executor.runGraph({
    runId,
    graphId: LANGGRAPH_GRAPH_IDS["pr-review"],
    messages: [{ role: "user", content: userMessage }],
    modelRef: { providerKey: "platform", modelId: model },
    responseFormat: {
      prompt:
        "Respond with a JSON object containing a `metrics` array and a `summary` string. " +
        "Each metric entry must have: `metric` (name), `value` (0.0-1.0), `observations` (string array).",
      schema: EvaluationOutputSchema,
    },
  });

  // Drain stream and get final result
  for await (const _event of result.stream) {
    // Drain to completion — billing side-effects happen during iteration
  }

  const final = await result.final;

  if (!final.ok) {
    return {
      gateId: rule.id,
      gateType: "ai-rule",
      status: "neutral",
      summary: `AI evaluation failed: ${final.error ?? "unknown error"}`,
    };
  }

  // Extract structured output — fall back to empty metrics if missing
  const structured = final.structuredOutput as EvaluationOutput | undefined;

  // Build scores map for criteria evaluation
  const scores = new Map<string, number>();
  const metrics: Array<{
    metric: string;
    score: number;
    requirement?: string;
    observation: string;
  }> = [];

  if (structured?.metrics) {
    for (const entry of structured.metrics) {
      // Only include metrics that were requested in the rule evaluations
      if (metricNames.includes(entry.metric)) {
        scores.set(entry.metric, entry.value);
        const req = findRequirement(entry.metric, rule.success_criteria);
        metrics.push({
          metric: entry.metric,
          score: entry.value,
          ...(req != null ? { requirement: req } : {}),
          observation: entry.observations.join("; "),
        });
      }
    }
  }

  // Apply success criteria thresholds deterministically
  const status = evaluateCriteria(scores, rule.success_criteria);

  return {
    gateId: rule.id,
    gateType: "ai-rule",
    status,
    summary:
      status === "pass"
        ? `Rule "${rule.id}" passed`
        : status === "fail"
          ? `Rule "${rule.id}" failed threshold checks`
          : `Rule "${rule.id}" neutral (missing metrics or evaluation issue)`,
    metrics,
  };
}
