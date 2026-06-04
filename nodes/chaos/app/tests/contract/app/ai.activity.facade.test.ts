// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/ai.activity.facade`
 * Purpose: Contract tests for ActivityFacade.
 * Scope: Verifies getActivity against contract schema. Does not test UI.
 * Invariants:
 * - Per CHARGE_RECEIPTS_IS_LEDGER_TRUTH: facade reads charge_receipts as primary source
 * - LLM detail (model/tokens) fetched via listLlmChargeDetails, merged in facade
 * Side-effects: IO
 * Links: [ActivityFacade](../../../src/app/_facades/ai/activity.server.ts)
 * @internal
 */

import { aiActivityOperation } from "@cogni/node-contracts";
import { TEST_GRAPH_NAME, TEST_SESSION_USER_1 } from "@tests/_fakes";
import { describe, expect, it, vi } from "vitest";
import { getActivity } from "@/app/_facades/ai/activity.server";

// Mock dependencies — receipts-first (no usageService)
vi.mock("@/bootstrap/container", () => ({
  resolveActivityDeps: () => ({
    accountService: {
      listChargeReceipts: vi.fn().mockResolvedValue([
        {
          id: "receipt-1",
          litellmCallId: "log-1",
          chargedCredits: "0.050000",
          responseCostUsd: "0.05",
          sourceSystem: "litellm",
          receiptKind: "llm",
          createdAt: new Date("2024-01-01T12:00:00Z"),
        },
      ]),
      listLlmChargeDetails: vi.fn().mockResolvedValue([
        {
          chargeReceiptId: "receipt-1",
          providerCallId: "log-1",
          model: "gpt-4",
          provider: "openai",
          tokensIn: 10,
          tokensOut: 20,
          latencyMs: 500,
          graphId: TEST_GRAPH_NAME,
        },
      ]),
    },
  }),
}));

vi.mock("@/lib/auth/mapping", () => ({
  getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
    id: "billing-1",
  }),
}));

describe("Activity Facade", () => {
  it("should return valid contract data", async () => {
    const input = {
      from: "2024-01-01T00:00:00Z",
      to: "2024-01-02T00:00:00Z",
      limit: 10,
      sessionUser: TEST_SESSION_USER_1,
    };

    const result = await getActivity(input);

    // Validate against Zod schema
    const parsed = aiActivityOperation.output.safeParse(result);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      console.error(parsed.error);
    }

    // Server derives optimal step for 1-day range (24 hours)
    // deriveStep picks finest step with ≤48 buckets: 24h / 1h = 24 buckets
    expect(result.effectiveStep).toBe("1h");
    expect(result.chartSeries).toHaveLength(24); // Zero-filled buckets

    // Spend computed from charge receipts (primary source)
    // Mock receipt has responseCostUsd: "0.05" → total = 0.050000
    expect(result.totals.spend.total).toBe("0.050000");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.id).toBe("receipt-1");
    expect(result.rows[0]?.model).toBe("gpt-4");
    expect(result.rows[0]?.tokensIn).toBe(10);
    expect(result.rows[0]?.tokensOut).toBe(20);
    expect(result.nextCursor).toBeNull(); // Only 1 receipt, no next page
  });
});
