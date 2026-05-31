// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes`
 * Purpose: Verifies test fake availability and exports for deterministic unit testing conditions.
 * Scope: Re-exports fake implementations for testing. Does NOT export internal utilities or real implementations.
 * Invariants: All fakes available via barrel export; no circular dependencies; clean public API maintained.
 * Side-effects: none
 * Notes: Import fakes from here to replace I/O, time, and RNG in unit tests.
 * Links: tests/setup.ts
 * @public
 */

export { FakeAiTelemetryAdapter } from "@/adapters/test";
export {
  createMockAccountService,
  createMockAccountServiceWithDefaults,
  type MockAccountServiceOptions,
} from "./accounts/mock-account.service";
export * from "./ai/fakes";
export { FakeClock } from "./fake-clock";
export { FakeRng } from "./fake-rng";
export { FakeTelemetry } from "./fake-telemetry";
export {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
  newTestSessionUser,
  newTestUserId,
  SYSTEM_BILLING_ACCOUNT,
  TEST_SESSION_USER_1,
  TEST_SESSION_USER_2,
  TEST_SESSION_USER_3,
  TEST_SESSION_USER_4,
  TEST_SESSION_USER_5,
  TEST_USER_ID_1,
  TEST_USER_ID_2,
  TEST_USER_ID_3,
  TEST_USER_ID_4,
  TEST_USER_ID_5,
  TEST_WALLET_1,
  TEST_WALLET_2,
  TEST_WALLET_3,
  TEST_WALLET_4,
  TEST_WALLET_5,
  testUser,
} from "./ids";
export * from "./payments/fakes";
export { makeTestCtx, type TestCtxOptions } from "./test-context";
