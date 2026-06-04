// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/ai/services/metrics`
 * Purpose: Unit tests for metrics module.
 * Scope: Tests success/error path metric recording with mocked Prometheus metrics. Does NOT test real Prometheus integration or model catalog.
 * Invariants: Success records duration/tokens/cost; error records error counter only.
 * Side-effects: none (mocked)
 * Notes: MVP tests only - verifies correct metrics called per path.
 * Links: metrics.ts, COMPLETION_REFACTOR_PLAN.md
 * @public
 */

import { TEST_MODEL_ID } from "@tests/_fakes";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock functions so they're available during vi.mock hoisting
const { mockObserve, mockIncTokens, mockIncCost, mockIncErrors } = vi.hoisted(
  () => ({
    mockObserve: vi.fn(),
    mockIncTokens: vi.fn(),
    mockIncCost: vi.fn(),
    mockIncErrors: vi.fn(),
  })
);

// Mock model catalog
vi.mock("@/shared/ai/model-catalog.server", () => ({
  getModelClass: vi.fn().mockResolvedValue("standard"),
}));

// Mock Prometheus metrics
vi.mock("@/shared/observability", () => ({
  aiLlmCallDurationMs: { observe: mockObserve },
  aiLlmTokensTotal: { inc: mockIncTokens },
  aiLlmCostUsdTotal: { inc: mockIncCost },
  aiLlmErrorsTotal: { inc: mockIncErrors },
}));

import { recordMetrics } from "@/features/ai/services/metrics";

describe("recordMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("success path records duration, tokens, cost", async () => {
    await recordMetrics({
      model: TEST_MODEL_ID,
      durationMs: 1000,
      tokensUsed: 500,
      providerCostUsd: 0.05,
      isError: false,
    });

    // Duration histogram recorded
    expect(mockObserve).toHaveBeenCalledWith(
      { provider: "litellm", model_class: "standard" },
      1000
    );
    // Tokens counter incremented
    expect(mockIncTokens).toHaveBeenCalledWith(
      { provider: "litellm", model_class: "standard" },
      500
    );
    // Cost counter incremented
    expect(mockIncCost).toHaveBeenCalledWith(
      { provider: "litellm", model_class: "standard" },
      0.05
    );
    // Error counter NOT called
    expect(mockIncErrors).not.toHaveBeenCalled();
  });

  it("error path records error counter only", async () => {
    await recordMetrics({
      model: TEST_MODEL_ID,
      durationMs: 500,
      isError: true,
      errorCode: "rate_limit",
    });

    // Error counter incremented with code
    expect(mockIncErrors).toHaveBeenCalledWith({
      provider: "litellm",
      code: "rate_limit",
      model_class: "standard",
    });
    // Success metrics NOT called
    expect(mockObserve).not.toHaveBeenCalled();
    expect(mockIncTokens).not.toHaveBeenCalled();
    expect(mockIncCost).not.toHaveBeenCalled();
  });
});
