// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/services/creditsConfirm`
 * Purpose: Verifies widget payment confirmation service logic including system tenant revenue share.
 * Scope: Covers feature-layer credit calculations, idempotency checks, revenue share bonus minting, and validation with mocked ports; does not test port implementations or HTTP layer.
 * Invariants: 1 cent = 100,000 credits (CREDITS_PER_USD / 100); idempotent per clientPaymentId; system tenant bonus is sequential + idempotent.
 * Side-effects: none
 * Notes: Uses mocked AccountService and ServiceAccountService with stub implementations.
 * Links: docs/spec/payments-design.md, docs/spec/system-tenant.md, src/features/payments/services/creditsConfirm.ts
 * @public
 */

import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  PLATFORM_REVENUE_SHARE_REASON,
  WIDGET_PAYMENT_REASON,
} from "@cogni/node-shared";
import { createMockAccountService } from "@tests/_fakes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmCreditsPayment } from "@/features/payments/services/creditsConfirm";
import type { CreditLedgerEntry, ServiceAccountService } from "@/ports";

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ SYSTEM_TENANT_REVENUE_SHARE: 0.75 }),
}));

function createMockServiceAccountService(): ServiceAccountService {
  return {
    getBillingAccountById: vi.fn(),
    getOrCreateBillingAccountForUser: vi.fn(),
    creditAccount: vi.fn().mockResolvedValue({ newBalance: 0 }),
    findCreditLedgerEntryByReference: vi.fn().mockResolvedValue(null),
  };
}

describe("features/payments/services/creditsConfirm", () => {
  const billingAccountId = "billing-123";
  const defaultVirtualKeyId = "vk-123";

  const createMocks = () => {
    const accountService = createMockAccountService();
    const serviceAccountService = createMockServiceAccountService();
    const findByReference =
      accountService.findCreditLedgerEntryByReference as unknown as ReturnType<
        typeof vi.fn
      >;
    const creditAccount = accountService.creditAccount as unknown as ReturnType<
      typeof vi.fn
    >;
    const svcFindByReference =
      serviceAccountService.findCreditLedgerEntryByReference as ReturnType<
        typeof vi.fn
      >;
    const svcCreditAccount = serviceAccountService.creditAccount as ReturnType<
      typeof vi.fn
    >;

    return {
      accountService,
      serviceAccountService,
      findByReference,
      creditAccount,
      svcFindByReference,
      svcCreditAccount,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("credits new payments and returns updated balance with merged metadata", async () => {
    const {
      accountService,
      serviceAccountService,
      findByReference,
      creditAccount,
    } = createMocks();

    // 1000 cents = $10 = 100,000,000 credits (at CREDITS_PER_USD = 10,000,000)
    const expectedCredits = 100_000_000;

    findByReference.mockResolvedValue(null);
    creditAccount.mockResolvedValue({ newBalance: expectedCredits });

    const result = await confirmCreditsPayment(
      accountService,
      serviceAccountService,
      {
        billingAccountId,
        defaultVirtualKeyId,
        amountUsdCents: 1_000,
        clientPaymentId: "payment-1",
        metadata: { txHash: "0xabc" },
      }
    );

    expect(findByReference).toHaveBeenCalledWith({
      billingAccountId,
      reason: WIDGET_PAYMENT_REASON,
      reference: "payment-1",
    });

    expect(creditAccount).toHaveBeenCalledWith({
      billingAccountId,
      amount: expectedCredits, // 1000 cents = $10 * 10_000_000 credits/USD
      reason: WIDGET_PAYMENT_REASON,
      reference: "payment-1",
      virtualKeyId: defaultVirtualKeyId,
      metadata: {
        provider: "depay",
        amountUsdCents: 1_000,
        txHash: "0xabc",
      },
    });

    expect(result).toEqual({
      billingAccountId,
      balanceCredits: expectedCredits,
      creditsApplied: expectedCredits,
    });
  });

  it("returns existing balance and skips crediting when ledger entry already exists", async () => {
    const {
      accountService,
      serviceAccountService,
      findByReference,
      creditAccount,
      svcCreditAccount,
    } = createMocks();

    const existingEntry: CreditLedgerEntry = {
      id: "ledger-1",
      billingAccountId,
      virtualKeyId: defaultVirtualKeyId,
      amount: 5_000,
      balanceAfter: 12_345,
      reason: WIDGET_PAYMENT_REASON,
      reference: "payment-duplicate",
      metadata: { original: true },
      createdAt: new Date("2025-01-01T00:00:00Z"),
    };

    findByReference.mockResolvedValue(existingEntry);

    const result = await confirmCreditsPayment(
      accountService,
      serviceAccountService,
      {
        billingAccountId,
        defaultVirtualKeyId,
        amountUsdCents: 500,
        clientPaymentId: "payment-duplicate",
      }
    );

    expect(creditAccount).not.toHaveBeenCalled();
    expect(svcCreditAccount).not.toHaveBeenCalled();
    expect(result).toEqual({
      billingAccountId,
      balanceCredits: existingEntry.balanceAfter,
      creditsApplied: 0,
    });
  });

  it("throws when amountUsdCents is not greater than zero", async () => {
    const { accountService, serviceAccountService, findByReference } =
      createMocks();
    findByReference.mockResolvedValue(null);

    await expect(
      confirmCreditsPayment(accountService, serviceAccountService, {
        billingAccountId,
        defaultVirtualKeyId,
        amountUsdCents: 0,
        clientPaymentId: "payment-invalid",
      })
    ).rejects.toThrow("amountUsdCents must be greater than zero");
  });

  describe("system tenant revenue share", () => {
    it("mints bonus credits to system tenant after user credit", async () => {
      const {
        accountService,
        serviceAccountService,
        findByReference,
        creditAccount,
        svcFindByReference,
        svcCreditAccount,
      } = createMocks();

      // 1000 cents = $10 = 100,000,000 credits
      const expectedCredits = 100_000_000;
      // 75% bonus = 75,000,000
      const expectedBonus = 75_000_000;

      findByReference.mockResolvedValue(null);
      creditAccount.mockResolvedValue({ newBalance: expectedCredits });
      svcFindByReference.mockResolvedValue(null);

      await confirmCreditsPayment(accountService, serviceAccountService, {
        billingAccountId,
        defaultVirtualKeyId,
        amountUsdCents: 1_000,
        clientPaymentId: "payment-rev-share",
      });

      // User credit happens first
      expect(creditAccount).toHaveBeenCalledTimes(1);

      // System tenant idempotency check
      expect(svcFindByReference).toHaveBeenCalledWith({
        billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
        reason: PLATFORM_REVENUE_SHARE_REASON,
        reference: "payment-rev-share",
      });

      // System tenant bonus credit
      expect(svcCreditAccount).toHaveBeenCalledWith({
        billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
        amount: expectedBonus,
        reason: PLATFORM_REVENUE_SHARE_REASON,
        reference: "payment-rev-share",
      });
    });

    it("skips system tenant credit when bonus already exists (idempotent retry)", async () => {
      const {
        accountService,
        serviceAccountService,
        findByReference,
        creditAccount,
        svcFindByReference,
        svcCreditAccount,
      } = createMocks();

      findByReference.mockResolvedValue(null);
      creditAccount.mockResolvedValue({ newBalance: 100_000_000 });

      // Simulate existing bonus entry (prior successful write)
      svcFindByReference.mockResolvedValue({
        id: "bonus-1",
        billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
        virtualKeyId: "sys-vk",
        amount: 75_000_000,
        balanceAfter: 75_000_000,
        reason: PLATFORM_REVENUE_SHARE_REASON,
        reference: "payment-retry",
        metadata: null,
        createdAt: new Date(),
      });

      await confirmCreditsPayment(accountService, serviceAccountService, {
        billingAccountId,
        defaultVirtualKeyId,
        amountUsdCents: 1_000,
        clientPaymentId: "payment-retry",
      });

      // User credit still happens
      expect(creditAccount).toHaveBeenCalledTimes(1);
      // System tenant credit skipped
      expect(svcCreditAccount).not.toHaveBeenCalled();
    });
  });
});
