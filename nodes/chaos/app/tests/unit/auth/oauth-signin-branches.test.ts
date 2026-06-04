// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/auth/oauth-signin-branches`
 * Purpose: Unit tests for OAuth signIn callback early-return branches and WalletRequiredError guard.
 * Scope: Tests pure branch logic (no DB needed). Mocks DB and adapter imports to prevent connections. Does not test DB-interacting paths.
 * Invariants: SIWE/null account → true; unknown provider → false; null wallet → WalletRequiredError.
 * Side-effects: none
 * Links: src/auth.ts (signIn callback), src/features/payments/errors.ts
 * @public
 */

import { TEST_USER_ID_1 } from "@tests/_fakes/ids";
import type { Account, User } from "next-auth";
import { describe, expect, it, vi } from "vitest";

// --- Mocks (must precede imports of modules under test) ---

// Prevent DB connection on module load
vi.mock("@/adapters/server/db/drizzle.service-client", () => ({
  getServiceDb: vi.fn(),
}));

// Prevent adapter import chain
vi.mock("@/adapters/server/identity/create-binding", () => ({
  createBinding: vi.fn(),
}));

// Stub logger to prevent env validation
vi.mock("@/shared/observability", () => {
  const noop = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  });
  return { makeLogger: noop, makeNoopLogger: noop };
});

// Stub getCsrfToken (imported at module level by auth.ts)
vi.mock("next-auth/react", () => ({
  getCsrfToken: vi.fn(),
}));

// Now import the module under test
import { authOptions } from "@/auth";

// biome-ignore lint/style/noNonNullAssertion: test setup — callbacks and signIn are always defined in authOptions
const signIn = authOptions.callbacks!.signIn!;

describe("OAuth signIn callback — early-return branches", () => {
  it("passes through SIWE (credentials) provider", async () => {
    const result = await signIn({
      user: { id: TEST_USER_ID_1 } as User,
      account: { provider: "credentials" } as Account,
      profile: undefined,
      credentials: undefined,
      email: undefined,
    });
    expect(result).toBe(true);
  });

  it("passes through when account is null", async () => {
    const result = await signIn({
      user: { id: TEST_USER_ID_1 } as User,
      account: null as unknown as Account,
      profile: undefined,
      credentials: undefined,
      email: undefined,
    });
    expect(result).toBe(true);
  });

  it("rejects unknown OAuth provider", async () => {
    const result = await signIn({
      user: { id: TEST_USER_ID_1 } as User,
      account: {
        provider: "twitter",
        type: "oauth",
        providerAccountId: "x",
      } as Account,
      profile: undefined,
      credentials: undefined,
      email: undefined,
    });
    expect(result).toBe(false);
  });
});

// --- WalletRequiredError guard test ---

// Additional mocks for the facade under test
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    accountsForUser: vi.fn().mockReturnValue({}),
    paymentAttemptsForUser: vi.fn().mockReturnValue({}),
    clock: { now: () => new Date() },
  }),
}));

vi.mock("@/lib/auth/mapping", () => ({
  getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
    id: "billing-account-id",
    defaultVirtualKeyId: "vk-id",
  }),
}));

import { makeTestCtx } from "@tests/_fakes";
import { createPaymentIntentFacade } from "@/app/_facades/payments/attempts.server";
import { WalletRequiredError } from "@/features/payments/errors";

describe("WalletRequiredError guard", () => {
  it("throws WalletRequiredError when walletAddress is null", async () => {
    const ctx = makeTestCtx({ routeId: "test", reqId: "req-1" });

    await expect(
      createPaymentIntentFacade(
        {
          sessionUser: { id: TEST_USER_ID_1, walletAddress: null },
          amountUsdCents: 500,
        },
        ctx
      )
    ).rejects.toThrow(WalletRequiredError);
  });
});
