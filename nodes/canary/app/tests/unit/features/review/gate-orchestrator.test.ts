// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/review/gate-orchestrator`
 * Purpose: Unit tests for gate orchestrator — ordering, aggregation, crash isolation, and timeout.
 * Scope: Tests with mocked gate implementations. Does NOT test real LLM or GitHub API calls.
 * Invariants: Gates run in declared order. Crash → neutral. Timeout → neutral. Aggregation: fail > neutral > pass.
 * Side-effects: none
 * Links: task.0153
 * @public
 */

import type { GateConfig } from "@cogni/repo-spec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EvidenceBundle } from "@/features/review/types";

// Mock gate implementations before importing orchestrator
vi.mock("@/features/review/gates/ai-rule", () => ({
  evaluateAiRule: vi.fn(),
}));
vi.mock("@/features/review/gates/review-limits", () => ({
  evaluateReviewLimits: vi.fn(),
}));

// Import after mocks
const { runGates } = await import("@/features/review/gate-orchestrator");
const { evaluateReviewLimits } = await import(
  "@/features/review/gates/review-limits"
);
const { evaluateAiRule } = await import("@/features/review/gates/ai-rule");

const mockLog = {
  child: vi.fn().mockReturnThis(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as import("pino").Logger;

const evidence: EvidenceBundle = {
  prNumber: 1,
  prTitle: "test",
  prBody: "",
  headSha: "abc",
  baseBranch: "main",
  changedFiles: 3,
  additions: 50,
  deletions: 10,
  patches: [],
  totalDiffBytes: 2048,
};

const baseDeps = {
  executor: {} as import("@/ports").GraphExecutorPort,
  caller: {} as import("@/ports").LlmCaller,
  model: "test-model",
  log: mockLog,
  loadRule: vi.fn(),
  gateTimeoutMs: 500,
};

describe("runGates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns pass when all gates pass", async () => {
    vi.mocked(evaluateReviewLimits).mockReturnValue({
      gateId: "review-limits",
      gateType: "review-limits",
      status: "pass",
      summary: "ok",
    });

    const gates: GateConfig[] = [
      { type: "review-limits", with: { max_changed_files: 10 } },
    ];

    const result = await runGates(gates, evidence, baseDeps);
    expect(result.conclusion).toBe("pass");
    expect(result.gateResults).toHaveLength(1);
  });

  it("aggregates fail > neutral > pass", async () => {
    vi.mocked(evaluateReviewLimits).mockReturnValue({
      gateId: "review-limits",
      gateType: "review-limits",
      status: "neutral",
      summary: "too big",
    });
    vi.mocked(evaluateAiRule).mockResolvedValue({
      gateId: "code-quality",
      gateType: "ai-rule",
      status: "fail",
      summary: "failed",
    });
    baseDeps.loadRule.mockReturnValue({
      id: "code-quality",
      blocking: true,
      evaluations: [{ coherence: "evaluate" }],
      success_criteria: { neutral_on_missing_metrics: false },
    });

    const gates: GateConfig[] = [
      { type: "review-limits", with: { max_changed_files: 1 } },
      { type: "ai-rule", with: { rule_file: "test.yaml" } },
    ];

    const result = await runGates(gates, evidence, baseDeps);
    expect(result.conclusion).toBe("fail");
    expect(result.gateResults).toHaveLength(2);
  });

  it("catches gate crash and returns neutral", async () => {
    vi.mocked(evaluateReviewLimits).mockImplementation(() => {
      throw new Error("boom");
    });

    const gates: GateConfig[] = [
      { type: "review-limits", with: { max_changed_files: 10 } },
    ];

    const result = await runGates(gates, evidence, baseDeps);
    expect(result.conclusion).toBe("neutral");
    expect(result.gateResults[0]?.summary).toContain("crashed");
  });

  it("returns neutral on timeout", async () => {
    vi.mocked(evaluateAiRule).mockImplementation(
      () =>
        new Promise(() => {
          // Never resolves — simulates a hung gate
        })
    );
    baseDeps.loadRule.mockReturnValue({
      id: "slow-rule",
      blocking: true,
      evaluations: [{ x: "y" }],
      success_criteria: { neutral_on_missing_metrics: false },
    });

    const gates: GateConfig[] = [
      { type: "ai-rule", with: { rule_file: "slow.yaml" } },
    ];

    const promise = runGates(gates, evidence, {
      ...baseDeps,
      gateTimeoutMs: 100,
    });

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result.conclusion).toBe("neutral");
    expect(result.gateResults[0]?.summary).toContain("timed out");
  });

  it("returns pass for empty gates array", async () => {
    const result = await runGates([], evidence, baseDeps);
    expect(result.conclusion).toBe("pass");
    expect(result.gateResults).toHaveLength(0);
  });
});
