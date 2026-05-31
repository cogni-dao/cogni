// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/payments/mock-services`
 * Purpose: Mock factories for payment-related port interfaces used in unit tests.
 * Scope: Controllable vi.fn() mocks for ServiceAccountService, TreasurySettlementPort, ProviderFundingPort, and FinancialLedgerPort.
 * Invariants: All methods return vi.fn() mocks; no real I/O.
 * Side-effects: none
 * Links: src/ports/
 * @public
 */

import type { FinancialLedgerPort } from "@cogni/financial-ledger";
import { vi } from "vitest";
import type {
  ProviderFundingPort,
  ServiceAccountService,
  TreasurySettlementPort,
} from "@/ports";

export function createMockServiceAccountService(): ServiceAccountService {
  return {
    getBillingAccountById: vi.fn(),
    getOrCreateBillingAccountForUser: vi.fn(),
    creditAccount: vi.fn().mockResolvedValue({ newBalance: 0 }),
    findCreditLedgerEntryByReference: vi.fn().mockResolvedValue(null),
  };
}

export function createMockTreasurySettlement(): TreasurySettlementPort & {
  settleConfirmedCreditPurchase: ReturnType<typeof vi.fn>;
} {
  return {
    settleConfirmedCreditPurchase: vi
      .fn()
      .mockResolvedValue({ txHash: "0xfake-settlement-tx" }),
  };
}

export function createMockFinancialLedger(): FinancialLedgerPort & {
  transfer: ReturnType<typeof vi.fn>;
} {
  return {
    transfer: vi.fn().mockResolvedValue(undefined),
    linkedTransfers: vi.fn().mockResolvedValue(undefined),
    lookupAccounts: vi.fn().mockResolvedValue([]),
    getAccountBalance: vi.fn(),
  };
}

export function createMockProviderFunding(): ProviderFundingPort & {
  fundAfterCreditPurchase: ReturnType<typeof vi.fn>;
} {
  return {
    fundAfterCreditPurchase: vi
      .fn()
      .mockResolvedValue({ txHash: "0xfake-funding-tx", topUpUsd: 0.9211 }),
  };
}
