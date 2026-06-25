// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/application/confirmCreditsPurchase`
 * Purpose: Verifies the application orchestrator composes credit confirmation with treasury settlement and the Split-distribute TB co-write correctly.
 * Scope: Covers orchestration: delegation to creditsConfirm, treasury settlement, the Treasury→OperatorFloat TB co-write, graceful degradation on failure, skip on idempotent replay. Provider top-up was retired (x402 egress lands later) — no provider-funding cases.
 * Invariants: Credit confirmation always succeeds independently of downstream steps; settlement skipped when creditsApplied=0; all post-settlement steps non-blocking.
 * Side-effects: none
 * Links: src/features/payments/application/confirmCreditsPurchase.ts, task.0086
 * @public
 */

import {
  createMockAccountService,
  createMockFinancialLedger,
  createMockServiceAccountService,
  createMockTreasurySettlement,
} from "@tests/_fakes";
import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConfirmCreditsPurchaseDeps,
  confirmCreditsPurchase,
  type PostCreditFundingDeps,
  runPostCreditFunding,
} from "@/features/payments/application/confirmCreditsPurchase";
import { confirmCreditsPayment } from "@/features/payments/services/creditsConfirm";

vi.mock("@/features/payments/services/creditsConfirm", () => ({
  confirmCreditsPayment: vi.fn(),
}));

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ SYSTEM_TENANT_REVENUE_SHARE: 0.75 }),
}));

const mockConfirmCreditsPayment = vi.mocked(confirmCreditsPayment);

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as Logger;

describe("features/payments/application/confirmCreditsPurchase", () => {
  const input = {
    billingAccountId: "billing-123",
    defaultVirtualKeyId: "vk-123",
    amountUsdCents: 1000,
    clientPaymentId: "payment-1",
    revenueShare: 0.75,
  };

  let accountService: ReturnType<typeof createMockAccountService>;
  let serviceAccountService: ServiceAccountService;

  function makeDeps(
    overrides: Partial<ConfirmCreditsPurchaseDeps> = {}
  ): ConfirmCreditsPurchaseDeps {
    return {
      accountService,
      serviceAccountService,
      treasurySettlement: undefined as TreasurySettlementPort | undefined,
      financialLedger: undefined as
        | ConfirmCreditsPurchaseDeps["financialLedger"]
        | undefined,
      log: mockLog,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    accountService = createMockAccountService();
    serviceAccountService = createMockServiceAccountService();

    mockConfirmCreditsPayment.mockResolvedValue({
      billingAccountId: "billing-123",
      balanceCredits: 100_000_000,
      creditsApplied: 100_000_000,
    });
  });

  it("confirms credits and settles treasury on success", async () => {
    const treasury = createMockTreasurySettlement();

    const result = await confirmCreditsPurchase(
      makeDeps({ treasurySettlement: treasury }),
      input
    );

    expect(mockConfirmCreditsPayment).toHaveBeenCalledWith(
      accountService,
      serviceAccountService,
      input
    );

    expect(treasury.settleConfirmedCreditPurchase).toHaveBeenCalledWith({
      paymentIntentId: "payment-1",
    });

    expect(result).toEqual({
      billingAccountId: "billing-123",
      balanceCredits: 100_000_000,
      creditsApplied: 100_000_000,
      settlement: { txHash: "0xfake-settlement-tx" },
    });
  });

  it("confirms credits without settlement when treasury port is undefined", async () => {
    const result = await confirmCreditsPurchase(makeDeps(), input);

    expect(mockConfirmCreditsPayment).toHaveBeenCalled();
    expect(result.settlement).toBeUndefined();
    expect(result.settlementError).toBeUndefined();
    expect(result.creditsApplied).toBe(100_000_000);
  });

  it("returns settlementError when treasury settlement fails", async () => {
    const treasury = createMockTreasurySettlement();
    const settlementErr = new Error("rpc timeout");
    treasury.settleConfirmedCreditPurchase.mockRejectedValue(settlementErr);

    const result = await confirmCreditsPurchase(
      makeDeps({ treasurySettlement: treasury }),
      input
    );

    // Credits still confirmed
    expect(result.billingAccountId).toBe("billing-123");
    expect(result.creditsApplied).toBe(100_000_000);
    // Settlement error surfaced for caller to log
    expect(result.settlementError).toBe(settlementErr);
    expect(result.settlement).toBeUndefined();
  });

  it("skips settlement on idempotent replay (creditsApplied=0)", async () => {
    const treasury = createMockTreasurySettlement();

    mockConfirmCreditsPayment.mockResolvedValue({
      billingAccountId: "billing-123",
      balanceCredits: 100_000_000,
      creditsApplied: 0,
    });

    const result = await confirmCreditsPurchase(
      makeDeps({ treasurySettlement: treasury }),
      input
    );

    expect(treasury.settleConfirmedCreditPurchase).not.toHaveBeenCalled();
    expect(result.creditsApplied).toBe(0);
    expect(result.settlement).toBeUndefined();
  });

  it("records TB co-write for Split distribute after settlement", async () => {
    const treasury = createMockTreasurySettlement();
    const ledger = createMockFinancialLedger();

    await confirmCreditsPurchase(
      makeDeps({ treasurySettlement: treasury, financialLedger: ledger }),
      input
    );

    // Exactly one TB transfer now: Split distribute (provider top-up co-write retired).
    expect(ledger.transfer).toHaveBeenCalledTimes(1);
    const call = ledger.transfer.mock.calls[0][0];
    expect(call.debitAccountId).toBe(2001n); // ASSETS_TREASURY
    expect(call.creditAccountId).toBe(2002n); // ASSETS_OPERATOR_FLOAT
    expect(call.ledger).toBe(2); // USDC
    expect(call.code).toBe(3); // SPLIT_DISTRIBUTE
  });

  it("continues when TB co-write fails (non-blocking)", async () => {
    const treasury = createMockTreasurySettlement();
    const ledger = createMockFinancialLedger();
    ledger.transfer.mockRejectedValue(new Error("TB unavailable"));

    const result = await confirmCreditsPurchase(
      makeDeps({ treasurySettlement: treasury, financialLedger: ledger }),
      input
    );

    // Credits still confirmed, settlement still returned
    expect(result.creditsApplied).toBe(100_000_000);
    expect(result.settlement).toEqual({ txHash: "0xfake-settlement-tx" });
  });
});

describe("runPostCreditFunding (extracted steps 3-4)", () => {
  const fundingInput = {
    paymentIntentId: "8453:0xabc123",
    amountUsdCents: 1000,
  };

  const mockLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;

  function makeFundingDeps(
    overrides: Partial<PostCreditFundingDeps> = {}
  ): PostCreditFundingDeps {
    return {
      treasurySettlement: undefined,
      financialLedger: undefined,
      log: mockLog,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs treasury settlement and records the Split-distribute co-write", async () => {
    const treasury = createMockTreasurySettlement();
    const ledger = createMockFinancialLedger();

    const result = await runPostCreditFunding(
      makeFundingDeps({
        treasurySettlement: treasury,
        financialLedger: ledger,
      }),
      fundingInput
    );

    expect(treasury.settleConfirmedCreditPurchase).toHaveBeenCalledWith({
      paymentIntentId: "8453:0xabc123",
    });
    expect(ledger.transfer).toHaveBeenCalledTimes(1); // Split distribute only
    expect(result.settlement).toBeDefined();
  });

  it("returns empty result when no ports configured", async () => {
    const result = await runPostCreditFunding(makeFundingDeps(), fundingInput);

    expect(result.settlement).toBeUndefined();
    expect(result.settlementError).toBeUndefined();
  });

  it("never throws — catches all errors internally", async () => {
    const treasury = createMockTreasurySettlement();
    treasury.settleConfirmedCreditPurchase.mockRejectedValue(
      new Error("chain error")
    );

    const result = await runPostCreditFunding(
      makeFundingDeps({ treasurySettlement: treasury }),
      fundingInput
    );

    expect(result.settlementError).toBeInstanceOf(Error);
    expect(result.settlement).toBeUndefined();
  });
});
