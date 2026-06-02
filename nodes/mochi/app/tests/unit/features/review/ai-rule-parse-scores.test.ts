// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/review/ai-rule-structured-output`
 * Purpose: Unit tests for the AI rule evaluation structured output schema.
 * Scope: Tests EvaluationOutputSchema validation. Does NOT test LLM calls or graph execution.
 * Invariants: Pure schema validation + mock-based integration.
 * Side-effects: none
 * Links: task.0153
 * @public
 */

import { describe, expect, it } from "vitest";

import {
  type EvaluationOutput,
  EvaluationOutputSchema,
} from "@/features/review/gates/ai-rule";

describe("EvaluationOutputSchema", () => {
  it("validates a well-formed evaluation output", () => {
    const input: EvaluationOutput = {
      metrics: [
        {
          metric: "coherent-change",
          value: 0.85,
          observations: ["Good alignment between title and diff"],
        },
        {
          metric: "non-malicious",
          value: 1.0,
          observations: ["No suspicious patterns found"],
        },
      ],
      summary: "PR looks good overall.",
    };

    const result = EvaluationOutputSchema.parse(input);
    expect(result.metrics).toHaveLength(2);
    expect(result.metrics[0]?.value).toBe(0.85);
    expect(result.summary).toBe("PR looks good overall.");
  });

  it("rejects value below 0", () => {
    const input = {
      metrics: [{ metric: "test", value: -0.1, observations: [] }],
      summary: "Bad",
    };

    expect(() => EvaluationOutputSchema.parse(input)).toThrow();
  });

  it("rejects value above 1", () => {
    const input = {
      metrics: [{ metric: "test", value: 1.5, observations: [] }],
      summary: "Bad",
    };

    expect(() => EvaluationOutputSchema.parse(input)).toThrow();
  });

  it("accepts empty metrics array", () => {
    const input = { metrics: [], summary: "No metrics evaluated." };
    const result = EvaluationOutputSchema.parse(input);
    expect(result.metrics).toHaveLength(0);
  });

  it("accepts multiple observations per metric", () => {
    const input = {
      metrics: [
        {
          metric: "quality",
          value: 0.7,
          observations: ["First note", "Second note", "Third note"],
        },
      ],
      summary: "Multi-observation test.",
    };

    const result = EvaluationOutputSchema.parse(input);
    expect(result.metrics[0]?.observations).toHaveLength(3);
  });

  it("accepts boundary values 0 and 1", () => {
    const input = {
      metrics: [
        { metric: "min", value: 0, observations: [] },
        { metric: "max", value: 1, observations: [] },
      ],
      summary: "Boundary test.",
    };

    const result = EvaluationOutputSchema.parse(input);
    expect(result.metrics[0]?.value).toBe(0);
    expect(result.metrics[1]?.value).toBe(1);
  });

  it("rejects missing summary", () => {
    const input = {
      metrics: [{ metric: "test", value: 0.5, observations: [] }],
    };

    expect(() => EvaluationOutputSchema.parse(input)).toThrow();
  });

  it("rejects missing metric name", () => {
    const input = {
      metrics: [{ value: 0.5, observations: [] }],
      summary: "Test",
    };

    expect(() => EvaluationOutputSchema.parse(input)).toThrow();
  });
});
