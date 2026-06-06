// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/activity.facade.billing-display`
 * Purpose: Regression tests for USD billing display in Activity facade.
 * Scope: Ensures chargedCredits are properly converted to USD for display (prevents #184 regression). Does not test database integration.
 * Invariants:
 * - Activity rows must show responseCostUsd (USD), not chargedCredits (raw credits)
 * - 10M credits = $1 USD (CREDITS_PER_USD constant)
 * - Test uses realistic charge_receipts + llm_charge_details data
 * - Per CHARGE_RECEIPTS_IS_LEDGER_TRUTH: facade reads receipts as primary source
 * Side-effects: none (pure unit test with mocks)
 * Links: src/app/_facades/ai/activity.server.ts, src/core/billing/pricing.ts
 * @internal
 */

import { CREDITS_PER_USD } from "@cogni/node-core";
import {
  TEST_GRAPH_NAME,
  TEST_GRAPH_NAME_2,
  TEST_SESSION_USER_1,
  TEST_SESSION_USER_2,
  TEST_SESSION_USER_3,
} from "@tests/_fakes";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the dependencies before importing getActivity
const mockListChargeReceipts = vi.fn();
const mockListLlmChargeDetails = vi.fn();
const mockGetOrCreateBillingAccountForUser = vi.fn();

vi.mock("@/bootstrap/container", () => ({
  resolveActivityDeps: () => ({
    accountService: {
      listChargeReceipts: mockListChargeReceipts,
      listLlmChargeDetails: mockListLlmChargeDetails,
    },
  }),
}));

vi.mock("@/lib/auth/mapping", () => ({
  getOrCreateBillingAccountForUser: mockGetOrCreateBillingAccountForUser,
}));

// Import after mocks are set up
const { getActivity } = await import("@/app/_facades/ai/activity.server");

describe("Activity Facade - Billing Display Regression Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrCreateBillingAccountForUser.mockResolvedValue({
      id: "billing-test-123",
    });
    // Default: no LLM details unless overridden
    mockListLlmChargeDetails.mockResolvedValue([]);
  });
  it("should display responseCostUsd (USD), not chargedCredits (raw credits)", async () => {
    // Realistic scenario: $0.001023 charge = 10,230 credits
    const providerCostUsd = 0.0005115; // LiteLLM provider cost
    const markupFactor = 2.0; // 100% markup
    const userCostUsd = providerCostUsd * markupFactor; // = 0.001023 USD
    const chargedCredits = Math.ceil(userCostUsd * CREDITS_PER_USD); // = 10,230 credits

    const mockReceipt = {
      id: "receipt-uuid-123",
      litellmCallId: "litellm-call-123",
      chargedCredits: chargedCredits.toString(), // "10230" (credits)
      responseCostUsd: userCostUsd.toFixed(6), // "0.001023" (USD)
      sourceSystem: "litellm" as const,
      receiptKind: "llm",
      createdAt: new Date("2024-01-01T12:00:00Z"),
    };

    const mockDetail = {
      chargeReceiptId: "receipt-uuid-123",
      providerCallId: "litellm-call-123",
      model: "anthropic/claude-sonnet-4.5",
      provider: "anthropic",
      tokensIn: 298,
      tokensOut: 340,
      latencyMs: 7500,
      graphId: TEST_GRAPH_NAME,
    };

    mockListChargeReceipts.mockResolvedValue([mockReceipt]);
    mockListLlmChargeDetails.mockResolvedValue([mockDetail]);

    const input = {
      from: "2024-01-01T00:00:00Z",
      to: "2024-01-02T00:00:00Z",
      limit: 10,
      sessionUser: TEST_SESSION_USER_1,
    };

    const result = await getActivity(input);

    // CRITICAL: Cost must be in USD (responseCostUsd), NOT raw credits (chargedCredits)
    // Before fix: would display "$10230.000000" (raw credits)
    // After fix: displays "$0.001023" (USD)
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.cost).toBe("0.001023"); // USD string, not credits
    expect(result.rows[0]?.id).toBe("receipt-uuid-123"); // stable charge_receipts UUID
    expect(result.rows[0]?.model).toBe("anthropic/claude-sonnet-4.5");
    expect(result.rows[0]?.tokensIn).toBe(298);
    expect(result.rows[0]?.tokensOut).toBe(340);

    // Validate spend totals are also in USD
    const expectedSpend = Number.parseFloat(mockReceipt.responseCostUsd);
    expect(result.totals.spend.total).toBe(expectedSpend.toFixed(6));

    // Ensure chartSeries spend is also in USD
    const bucketWithSpend = result.chartSeries.find(
      (s) => Number.parseFloat(s.spend) > 0
    );
    expect(bucketWithSpend).toBeDefined();
    if (bucketWithSpend) {
      expect(Number.parseFloat(bucketWithSpend.spend)).toBeCloseTo(
        expectedSpend,
        6
      );
    }
  });

  it("should handle missing responseCostUsd gracefully (show '—')", async () => {
    // Mock receipt with chargedCredits but NULL responseCostUsd (edge case: degraded billing)
    const mockReceipt = {
      id: "receipt-uuid-no-cost",
      litellmCallId: "litellm-call-no-cost",
      chargedCredits: "5000", // Has credits but no USD value recorded
      responseCostUsd: null, // NULL in DB
      sourceSystem: "litellm" as const,
      receiptKind: "llm",
      createdAt: new Date("2024-01-01T12:00:00Z"),
    };

    mockListChargeReceipts.mockResolvedValue([mockReceipt]);
    // No detail row either
    mockListLlmChargeDetails.mockResolvedValue([]);

    const input = {
      from: "2024-01-01T00:00:00Z",
      to: "2024-01-02T00:00:00Z",
      limit: 10,
      sessionUser: TEST_SESSION_USER_2,
    };

    const result = await getActivity(input);

    // When responseCostUsd is NULL, display should show "—" (not attempt credits conversion)
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.cost).toBe("—");
    expect(result.rows[0]?.model).toBe("unknown"); // No detail → fallback

    // Totals should be zero (no valid cost data)
    expect(result.totals.spend.total).toBe("0.000000");
  });

  it("should aggregate multiple charges correctly in USD", async () => {
    // Adapter returns DESC by createdAt — mock must match real ordering
    const receipts = [
      {
        id: "receipt-3",
        litellmCallId: "call-3",
        chargedCredits: "9100",
        responseCostUsd: "0.000910",
        sourceSystem: "litellm" as const,
        receiptKind: "llm",
        createdAt: new Date("2024-01-01T12:30:00Z"),
      },
      {
        id: "receipt-2",
        litellmCallId: "call-2",
        chargedCredits: "56780",
        responseCostUsd: "0.005678",
        sourceSystem: "litellm" as const,
        receiptKind: "llm",
        createdAt: new Date("2024-01-01T12:15:00Z"),
      },
      {
        id: "receipt-1",
        litellmCallId: "call-1",
        chargedCredits: "12340",
        responseCostUsd: "0.001234",
        sourceSystem: "litellm" as const,
        receiptKind: "llm",
        createdAt: new Date("2024-01-01T12:00:00Z"),
      },
    ];

    const details = [
      {
        chargeReceiptId: "receipt-1",
        providerCallId: "call-1",
        model: "gpt-4",
        provider: "openai",
        tokensIn: 100,
        tokensOut: 150,
        latencyMs: null,
        graphId: TEST_GRAPH_NAME,
      },
      {
        chargeReceiptId: "receipt-2",
        providerCallId: "call-2",
        model: "gpt-4",
        provider: "openai",
        tokensIn: 200,
        tokensOut: 250,
        latencyMs: null,
        graphId: TEST_GRAPH_NAME,
      },
      {
        chargeReceiptId: "receipt-3",
        providerCallId: "call-3",
        model: "gpt-4",
        provider: "openai",
        tokensIn: 50,
        tokensOut: 75,
        latencyMs: null,
        graphId: TEST_GRAPH_NAME,
      },
    ];

    mockListChargeReceipts.mockResolvedValue(receipts);
    mockListLlmChargeDetails.mockResolvedValue(details);

    const input = {
      from: "2024-01-01T00:00:00Z",
      to: "2024-01-02T00:00:00Z",
      limit: 10,
      sessionUser: TEST_SESSION_USER_3,
    };

    const result = await getActivity(input);

    // Verify individual row costs are in USD
    expect(result.rows).toHaveLength(3);
    // Receipts returned DESC by createdAt from adapter, facade paginates in that order
    expect(result.rows[0]?.cost).toBe("0.000910"); // receipt-3 (latest)
    expect(result.rows[1]?.cost).toBe("0.005678"); // receipt-2
    expect(result.rows[2]?.cost).toBe("0.001234"); // receipt-1

    // Verify total is sum of USD values, NOT sum of credits
    const expectedTotal = 0.001234 + 0.005678 + 0.00091; // = 0.007822 USD
    expect(result.totals.spend.total).toBe(expectedTotal.toFixed(6)); // "0.007822"

    // If we had mistakenly summed credits: 12340 + 56780 + 9100 = 78220 credits = $0.007822
    // But displaying as raw would show "$78220.000000" - the bug we're preventing
  });

  it("should pipe distinct graphId values through to rows", async () => {
    const receipts = [
      {
        id: "receipt-sandbox",
        litellmCallId: "call-sb",
        chargedCredits: "5000",
        responseCostUsd: "0.000500",
        sourceSystem: "litellm" as const,
        receiptKind: "llm",
        createdAt: new Date("2024-01-01T12:10:00Z"),
      },
      {
        id: "receipt-inproc",
        litellmCallId: "call-ip",
        chargedCredits: "3000",
        responseCostUsd: "0.000300",
        sourceSystem: "litellm" as const,
        receiptKind: "llm",
        createdAt: new Date("2024-01-01T12:00:00Z"),
      },
    ];

    const details = [
      {
        chargeReceiptId: "receipt-sandbox",
        providerCallId: "call-sb",
        model: "gpt-4",
        provider: "openai",
        tokensIn: 100,
        tokensOut: 50,
        latencyMs: null,
        graphId: TEST_GRAPH_NAME_2,
      },
      {
        chargeReceiptId: "receipt-inproc",
        providerCallId: "call-ip",
        model: "anthropic/claude-sonnet-4.5",
        provider: "anthropic",
        tokensIn: 200,
        tokensOut: 100,
        latencyMs: null,
        graphId: TEST_GRAPH_NAME,
      },
    ];

    mockListChargeReceipts.mockResolvedValue(receipts);
    mockListLlmChargeDetails.mockResolvedValue(details);

    const result = await getActivity({
      from: "2024-01-01T00:00:00Z",
      to: "2024-01-02T00:00:00Z",
      limit: 10,
      sessionUser: TEST_SESSION_USER_1,
    });

    expect(result.rows).toHaveLength(2);
    // DESC order: sandbox first (12:10), then inproc (12:00)
    expect(result.rows[0]?.graphId).toBe(TEST_GRAPH_NAME_2);
    expect(result.rows[0]?.model).toBe("gpt-4");
    expect(result.rows[1]?.graphId).toBe(TEST_GRAPH_NAME);
    expect(result.rows[1]?.model).toBe("anthropic/claude-sonnet-4.5");
  });
});
