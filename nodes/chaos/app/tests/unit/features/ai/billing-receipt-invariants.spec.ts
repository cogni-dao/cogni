// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/ai/billing-receipt-invariants.spec`
 * Purpose: Unit tests for RECEIPT_WRITES_REQUIRE_CALL_ID_AND_COST invariant in commitUsageFact.
 * Scope: Tests that receipts are written only when costUsd is a known number. Does not test database or actual billing writes.
 * Invariants: RECEIPT_WRITES_REQUIRE_CALL_ID_AND_COST, NO_PLACEHOLDER_RECEIPTS, COST_AUTHORITY_IS_LITELLM
 * Side-effects: none
 * Links: src/features/ai/services/billing.ts, docs/spec/billing-ingest.md
 * @internal
 */

import { buildInprocUsageFact } from "@tests/_fakes";
import { describe, expect, it, vi } from "vitest";

// Mock calculateDefaultLlmCharge — return deterministic values
vi.mock("@/features/ai/services/llmPricingPolicy", () => ({
  calculateDefaultLlmCharge: (costUsd: number) => ({
    chargedCredits: BigInt(Math.round(costUsd * 1_000_000)),
    userCostUsd: costUsd * 2,
  }),
}));

// Mock metrics — prevent prom-client registry side effects in unit tests
vi.mock("@/shared/observability/server/metrics", () => ({
  billingMissingCostDeferredTotal: { inc: vi.fn() },
  billingInvariantViolationTotal: { inc: vi.fn() },
}));

import { commitUsageFact } from "@/features/ai/services/billing";
import type { AccountService } from "@/ports";
import { makeNoopLogger } from "@/shared/observability";

function makeMockAccountService(): AccountService {
  return {
    getOrCreateBillingAccountForUser: vi.fn(),
    getBalance: vi.fn(),
    getBillingAccountById: vi.fn(),
    recordChargeReceipt: vi.fn(),
  };
}

const baseContext = { runId: "run-1", attempt: 0, ingressRequestId: "req-1" };

describe("RECEIPT_WRITES_REQUIRE_CALL_ID_AND_COST", () => {
  it("cost unknown + litellm source → no receipt (deferred to callback)", async () => {
    const accountService = makeMockAccountService();
    const log = makeNoopLogger();

    const fact = buildInprocUsageFact({
      source: "litellm",
      costUsd: undefined,
      model: "test-model",
    });

    await commitUsageFact(fact, baseContext, accountService, log);

    expect(accountService.recordChargeReceipt).not.toHaveBeenCalled();
  });

  it("cost unknown + non-litellm source → no receipt (invariant violation)", async () => {
    const accountService = makeMockAccountService();
    const log = makeNoopLogger();

    const fact = buildInprocUsageFact({
      source: "anthropic_sdk",
      costUsd: undefined,
      model: "test-model",
    });

    await commitUsageFact(fact, baseContext, accountService, log);

    expect(accountService.recordChargeReceipt).not.toHaveBeenCalled();
  });

  it("costUsd=0 → receipt written (0 is valid for free models)", async () => {
    const accountService = makeMockAccountService();
    const log = makeNoopLogger();

    const fact = buildInprocUsageFact({
      source: "litellm",
      costUsd: 0,
      model: "test-free-model",
    });

    await commitUsageFact(fact, baseContext, accountService, log);

    expect(accountService.recordChargeReceipt).toHaveBeenCalledTimes(1);
    const calls = (
      accountService.recordChargeReceipt as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(calls).toHaveLength(1);
    const call = calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.chargedCredits).toBe(0n);
    expect(call.responseCostUsd).toBe(0);
  });

  it("missing billingAccountId → no receipt (missing_billing_identity)", async () => {
    const accountService = makeMockAccountService();
    const log = makeNoopLogger();

    const fact = buildInprocUsageFact({
      billingAccountId: undefined,
      virtualKeyId: "vk-1",
      costUsd: 0.005,
    });

    await commitUsageFact(fact, baseContext, accountService, log);

    expect(accountService.recordChargeReceipt).not.toHaveBeenCalled();
  });

  it("missing virtualKeyId → no receipt (missing_billing_identity)", async () => {
    const accountService = makeMockAccountService();
    const log = makeNoopLogger();

    const fact = buildInprocUsageFact({
      billingAccountId: "billing-acct-1",
      virtualKeyId: undefined,
      costUsd: 0.005,
    });

    await commitUsageFact(fact, baseContext, accountService, log);

    expect(accountService.recordChargeReceipt).not.toHaveBeenCalled();
  });

  it("costUsd > 0 → receipt written with charge", async () => {
    const accountService = makeMockAccountService();
    const log = makeNoopLogger();

    const fact = buildInprocUsageFact({
      source: "litellm",
      costUsd: 0.005,
      model: "test-paid-model",
    });

    await commitUsageFact(fact, baseContext, accountService, log);

    expect(accountService.recordChargeReceipt).toHaveBeenCalledTimes(1);
    const calls = (
      accountService.recordChargeReceipt as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(calls).toHaveLength(1);
    const call = calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.chargedCredits).toBeGreaterThan(0n);
    expect(call.responseCostUsd).toBeGreaterThan(0);
  });
});
