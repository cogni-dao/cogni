// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/accounts/mock-account`
 * Purpose: Mock AccountService fixture for unit testing.
 * Scope: Test double with vi.fn() mocks for controllable behavior. Does not persist data.
 * Invariants: Returns proper mock functions for all AccountService methods
 * Side-effects: none (mock only)
 * Notes: Used for unit tests that need to mock the AccountService port
 * Links: Implements AccountService port interface
 * @public
 */

import { vi } from "vitest";

import type { AccountService } from "@/ports";
import { TEST_USER_ID_1 } from "../ids";

/**
 * Creates a mock AccountService with vi.fn() for all methods
 * Allows tests to control behavior and verify interactions
 */
export function createMockAccountService(): AccountService {
  return {
    getOrCreateBillingAccountForUser: vi.fn(),
    getBalance: vi.fn(),
    debitForUsage: vi.fn(),
    creditAccount: vi.fn(),
    listCreditLedgerEntries: vi.fn(),
    findCreditLedgerEntryByReference: vi.fn(),
    recordChargeReceipt: vi.fn(),
    listChargeReceipts: vi.fn(),
  };
}

/**
 * Options for creating mock AccountService with defaults
 */
export interface MockAccountServiceOptions {
  /** Balance in credits (default: 1_000_000_000 = $100 at 1e7 scale) */
  balanceCredits?: number;
}

/**
 * Creates a mock AccountService with default successful implementations
 * Useful for tests that need the service to "just work" without specific assertions
 *
 * @param options.balanceCredits - Balance in credits (default: 1_000_000_000 = $100 worth)
 */
export function createMockAccountServiceWithDefaults(
  options: MockAccountServiceOptions = {}
): AccountService {
  // Default to $100 worth of credits at CREDITS_PER_USD = 10_000_000
  const balanceCredits = options.balanceCredits ?? 1_000_000_000;

  return {
    getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
      id: "billing-test-account-id",
      ownerUserId: TEST_USER_ID_1,
      balanceCredits,
      defaultVirtualKeyId: "virtual-key-1",
    }),
    getBalance: vi.fn().mockResolvedValue(balanceCredits),
    debitForUsage: vi.fn().mockResolvedValue(undefined),
    creditAccount: vi
      .fn()
      .mockResolvedValue({ newBalance: balanceCredits + 50_000_000 }),
    listCreditLedgerEntries: vi.fn().mockResolvedValue([]),
    findCreditLedgerEntryByReference: vi.fn().mockResolvedValue(null),
    recordChargeReceipt: vi.fn().mockResolvedValue(undefined),
    listChargeReceipts: vi.fn().mockResolvedValue([]),
  };
}
