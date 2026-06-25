// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/payments/services/createIntent-fail-closed`
 * Purpose: Prove payment-intent creation fails CLOSED when the rail is active but
 *   outbound funding is unwired, and proceeds when funding is ready or in test-mode.
 * Scope: Exercises createIntent through the PaymentRailGuardPort seam with fakes.
 *   Does not hit the DB, chain, or env. Mocks getPaymentConfig (rail active).
 * Invariants: rail active + funding NOT wired → PAYMENT_RAIL_UNCONFIGURED before any
 *   transfer params are issued (no repo.create call). rail active + funding wired →
 *   intent created. test-mode (no-op guard) → intent created.
 * Links: src/features/payments/services/paymentService.ts,
 *   src/adapters/server/payments/funding-ready-rail-guard.adapter.ts, bug.5087
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FundingReadyRailGuardAdapter } from "@/adapters/server/payments/funding-ready-rail-guard.adapter";
import { PaymentRailNotReadyError } from "@/features/payments/errors";
import { createIntent } from "@/features/payments/services/paymentService";
import type { Clock, PaymentRailGuardPort } from "@/ports";

const RECEIVING = "0x4C4e559B2117AbA5f8BaE8a37d4B26BBAdc4C294";

vi.mock("@/shared/config/repoSpec.server", () => ({
  // Rail ACTIVE: payments_in configured.
  getPaymentConfig: () => ({
    chainId: 8453,
    receivingAddress: RECEIVING,
    markupFactor: 1.142857,
    revenueShare: 0,
  }),
}));

const clock: Clock = { now: () => 1_700_000_000_000 };

function fakeRepo() {
  const create = vi.fn(async (args: Record<string, unknown>) => ({
    id: "attempt-1",
    chainId: args.chainId,
    token: args.token,
    toAddress: args.toAddress,
    amountRaw: args.amountRaw,
    amountUsdCents: args.amountUsdCents,
    expiresAt: args.expiresAt,
  }));
  // Only `create` is reached by createIntent.
  return { create } as unknown as Parameters<typeof createIntent>[0] & {
    create: typeof create;
  };
}

const INPUT = {
  billingAccountId: "acct-1",
  fromAddress: "0x000000000000000000000000000000000000dEaD",
  amountUsdCents: 200,
};

// Inner inbound guard is a no-op here — we are testing the funding gate, not split-hash.
const passingInner: PaymentRailGuardPort = {
  assertReady: async () => undefined,
};

describe("createIntent fail-closed on outbound funding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rail active + funding NOT wired → throws PAYMENT_RAIL_UNCONFIGURED, no transfer params issued", async () => {
    const repo = fakeRepo();
    const guard = new FundingReadyRailGuardAdapter(passingInner, false);

    await expect(createIntent(repo, clock, guard, INPUT)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof PaymentRailNotReadyError &&
        err.code === "PAYMENT_RAIL_UNCONFIGURED"
    );
    // Fail-closed BEFORE the attempt is persisted (no USDC transfer params handed out).
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("rail active + funding wired → intent is created", async () => {
    const repo = fakeRepo();
    const guard = new FundingReadyRailGuardAdapter(passingInner, true);

    const result = await createIntent(repo, clock, guard, INPUT);

    expect(result.attemptId).toBe("attempt-1");
    expect(result.to).toBe(RECEIVING);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it("test-mode (no-op guard) → intent is created regardless of funding", async () => {
    const repo = fakeRepo();
    const noopGuard: PaymentRailGuardPort = {
      assertReady: async () => undefined,
    };

    const result = await createIntent(repo, clock, noopGuard, INPUT);

    expect(result.attemptId).toBe("attempt-1");
    expect(repo.create).toHaveBeenCalledTimes(1);
  });
});
